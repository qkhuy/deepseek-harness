/**
 * LiteLLM virtual-key sign-in: the {@link PrincipalService} provider for the
 * Web surface, its session table, and the routes a browser signs in through.
 *
 * One credential does both jobs. The virtual key a user types is verified
 * against the proxy's own management API, which is what authenticates them to
 * this harness — there is no second account system — and the same key is then
 * held in the session so that every model request made under it is authorized,
 * budgeted, and billed to that user by the proxy. No key configured in the
 * environment or in `settings.yaml` takes part in a signed-in request.
 *
 * Mounting this plugin turns the Web surface multi-user: `ctx.principal`
 * appears, the Connection carrier starts refusing unauthenticated `/api`
 * requests, and per-user consumers — the workspace registry, the LiteLLM
 * adapter — begin to separate one user's data and authority from another's.
 *
 * @module @deepseek-ai/dsh-litellm-auth
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LiteLlmClient, LiteLlmRequestError, resolveLiteLlmBaseUrl } from '@deepseek-ai/dsh-litellm-client'
import type { LiteLlmKeyIdentity } from '@deepseek-ai/dsh-litellm-client'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { PrincipalService } from '@deepseek-ai/dsh-principal'
import type { Principal, PrincipalRequest } from '@deepseek-ai/dsh-principal'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  BodyRejected, isSameSiteRequest, readCredentials, requestStyle, safeReturnPath, writeHtml, writeJson, writeRedirect,
} from './http.ts'
import { renderLoginPage } from './login-page.ts'
import { principalIdForLiteLlmUser } from './principal-id.ts'
import { LiteLlmSessionStore, readCookie, sessionCookie } from './session.ts'

export { LiteLlmSessionStore, readCookie, sessionCookie } from './session.ts'
export type { LiteLlmSession } from './session.ts'
export { principalIdForLiteLlmUser } from './principal-id.ts'
export { renderLoginPage } from './login-page.ts'
export type { LoginPageView } from './login-page.ts'
export { safeReturnPath } from './http.ts'

/** Cordis plugin name. */
export const name = 'litellm-auth'
/** Sign-in routes need the HTTP carrier; nothing else is required to mount. */
export const inject = ['webServer']

/** Path of the sign-in page and the endpoint its form posts to. */
export const LOGIN_PATH = '/auth/litellm'
/** Path that closes the current session. */
export const LOGOUT_PATH = '/auth/litellm/logout'
/** Path answering who the current request is, for programmatic clients. */
export const SESSION_PATH = '/auth/litellm/session'

const MINUTE_MS = 60 * 1000

/**
 * Plugin config. Every deployment-varying choice is here: the proxy to
 * authenticate against, how long a sign-in lasts, and the two cookie
 * attributes that depend on how the deployment is served.
 */
export interface Config {
  /**
   * LiteLLM proxy URL, with or without a `/v1` suffix. Omitted here it falls
   * back to `$LITELLM_BASE_URL` from a trusted environment layer; a mount that
   * resolves to neither fails at load, because there is no default proxy to
   * authenticate against and guessing one would send a user's key somewhere
   * they did not name.
   */
  baseURL?: string
  /** Session lifetime in minutes, from sign-in. @default 720 */
  sessionTtlMinutes?: number
  /** Timeout in milliseconds for each key-verification call to the proxy. @default 15000 */
  verifyTimeoutMs?: number
  /** Session cookie name. @default 'dsh-litellm-session' */
  cookieName?: string
  /**
   * Whether to mark the session cookie `Secure`. Enable it wherever the
   * surface is served over HTTPS; leaving it set on a plain-HTTP deployment
   * makes every sign-in silently fail to stick.
   * @default false
   */
  secureCookie?: boolean
  /**
   * Whether unauthenticated requests are refused. `false` keeps the surface
   * open and binds a principal only to requests that carry a session, which is
   * the posture for adding sign-in to a single-operator deployment without
   * locking it.
   * @default true
   */
  requireLogin?: boolean
  /** Extra headers sent with each proxy management call, for deployment routing. */
  headers?: Record<string, string>
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  sessionTtlMinutes: z.natural().min(1).default(720),
  verifyTimeoutMs: z.natural().min(1).default(15_000),
  cookieName: z.string().default('dsh-litellm-session'),
  secureCookie: z.boolean().default(false),
  requireLogin: z.boolean().default(true),
  headers: z.dict(z.string()).default({}),
})

/** Public view of a signed-in user; the key is deliberately absent. */
export interface LiteLlmSessionView {
  /** The harness principal id addressing this user's durable data. */
  readonly principalId: string
  /** Display label for UI surfaces. */
  readonly displayName: string
  /** Model ids this user may request; empty means unrestricted. */
  readonly models: readonly string[]
}

/**
 * Project one principal for a surface. The projection exists so that no code
 * path can answer a session query with the whole {@link Principal}, whose
 * `secret` is the user's key.
 * @param principal - the signed-in user.
 * @returns the fields safe to send to a client.
 */
export function sessionView(principal: Principal): LiteLlmSessionView {
  return { principalId: principal.id, displayName: principal.displayName, models: principal.models }
}

/** Build the principal one verified key authenticates as. */
function principalOf(identity: LiteLlmKeyIdentity, key: string): Principal {
  return {
    id: principalIdForLiteLlmUser(identity.userId),
    displayName: identity.keyAlias ?? identity.userId,
    secret: key,
    models: identity.models,
  }
}

/**
 * The principal provider backed by LiteLLM virtual keys. Authentication is the
 * session-cookie lookup; the key verification that opened the session happened
 * once, at sign-in.
 */
export class LiteLlmPrincipals extends PrincipalService {
  /**
   * @param ctx - Context of the mounting plugin.
   * @param sessions - the live session table.
   * @param cookieName - name of the session cookie to read.
   * @param requireLogin - whether unauthenticated requests must be refused.
   */
  constructor(
    ctx: Context,
    private readonly sessions: LiteLlmSessionStore,
    private readonly cookieName: string,
    private readonly requireLogin: boolean,
  ) {
    super(ctx)
  }

  override get required(): boolean {
    return this.requireLogin
  }

  override get signInUrl(): string {
    return LOGIN_PATH
  }

  override authenticate(request: PrincipalRequest): Principal | undefined {
    const { headers } = request
    const raw = headers instanceof Headers
      ? headers.get('cookie') ?? undefined
      : typeof headers.cookie === 'string' ? headers.cookie : undefined
    const token = readCookie(raw, this.cookieName)
    if (token === undefined) return undefined
    return this.sessions.resolve(token)?.principal
  }
}

/** Test hook for the proxy this plugin verifies keys against; production never mutates it. */
export const internals: {
  createClient: (options: ConstructorParameters<typeof LiteLlmClient>[0]) => LiteLlmClient
} = { createClient: options => new LiteLlmClient(options) }

/** Everything a route handler needs, assembled once at mount. */
interface Routes {
  readonly page: (req: IncomingMessage, res: ServerResponse) => void
  readonly signIn: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  readonly signOut: (req: IncomingMessage, res: ServerResponse) => void
  readonly session: (req: IncomingMessage, res: ServerResponse) => void
}

/** Refusals a user can act on, distinguished from ones only an operator can. */
function signInRefusal(error: unknown): { status: number; message: string } {
  if (error instanceof LiteLlmRequestError) {
    if (error.failure.code === 'AUTH') return { status: 401, message: 'That key was refused by the LiteLLM proxy.' }
    if (error.failure.code === 'TRANSPORT') {
      return { status: 502, message: 'The LiteLLM proxy could not be reached. Ask your operator to check its address.' }
    }
    return { status: 502, message: `The LiteLLM proxy could not verify the key: ${error.failure.message}` }
  }
  return { status: 500, message: 'Sign-in failed for an unexpected reason.' }
}

/**
 * Resolve the proxy endpoint: the configured value, else `$LITELLM_BASE_URL`
 * from a trusted environment layer (the shared resolution rule lives in
 * `dsh-litellm-client`, alongside `dsh-llm-litellm`'s identical need). The
 * one explicit resolve step from raw config to a usable endpoint.
 * @param config - raw plugin config.
 * @param environment - this run's environment layers, or `undefined` outside the product CLI.
 * @returns the resolved endpoint.
 * @throws Error when neither source names one.
 */
export function resolveBaseUrl(config: Config, environment?: LaunchEnvironmentSnapshot): string {
  const baseURL = resolveLiteLlmBaseUrl(config.baseURL, environment)
  if (baseURL === undefined) {
    throw new Error(
      'litellm-auth: no proxy endpoint to authenticate against; set this row\'s baseURL, or export'
      + ' LITELLM_BASE_URL in the launching environment',
    )
  }
  return baseURL
}

/**
 * Mount LiteLLM sign-in.
 * @param ctx - the plugin Context; the routes and the principal service bind to it.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Omit<Config, 'headers' | 'baseURL'>>
    & { baseURL?: string; headers: Record<string, string> }
  const baseURL = resolveBaseUrl(config, launchEnvironmentOf(ctx))
  const client = internals.createClient({
    baseURL,
    timeoutMs: resolved.verifyTimeoutMs,
    headers: resolved.headers,
  })
  const sessions = new LiteLlmSessionStore(resolved.sessionTtlMinutes * MINUTE_MS)
  const maxAgeSeconds = resolved.sessionTtlMinutes * 60

  ctx.effect(() => () => {
    // A reload must not leave live sessions holding keys verified against the
    // previous configuration's proxy.
    sessions.clear()
  }, 'litellm-auth: session table')

  // The Service base class publishes `ctx.principal` and ties it to this
  // fiber, so construction is the registration.
  const service = new LiteLlmPrincipals(ctx, sessions, resolved.cookieName, resolved.requireLogin)

  const requestedNext = (req: IncomingMessage): string => {
    /* v8 ignore next -- `?? LOGIN_PATH` arm: node:http always sets url on server
    requests; the field is only optional on the client-side IncomingMessage type */
    const url = new URL(req.url ?? LOGIN_PATH, 'http://dsh.invalid')
    return safeReturnPath(url.searchParams.get('next') ?? undefined)
  }

  const routes: Routes = {
    page: (req, res) => {
      writeHtml(res, 200, renderLoginPage({ action: LOGIN_PATH, next: requestedNext(req) }))
    },

    signIn: async (req, res) => {
      const style = requestStyle(req)
      if (!isSameSiteRequest(req)) {
        const message = 'Cross-site sign-in requests are refused.'
        if (style === 'json') writeJson(res, 403, { error: message })
        else writeHtml(res, 403, renderLoginPage({ action: LOGIN_PATH, next: '/', error: message }))
        return
      }
      let submitted: { apiKey?: string; next?: string }
      try {
        submitted = await readCredentials(req, style)
      } catch (error) {
        const rejection = error as BodyRejected
        // Every reachable readCredentials() failure is a BodyRejected; the
        // non-BodyRejected arms below defend a raw stream failure (the client
        // disconnecting mid-body), which closes the connection before any
        // response could reach it, so it has no client-observable test.
        /* v8 ignore next -- see above */
        const status = error instanceof BodyRejected ? rejection.status : 400
        /* v8 ignore next -- see above */
        const message = error instanceof BodyRejected ? rejection.message : 'sign-in request could not be read'
        if (style === 'json') writeJson(res, status, { error: message })
        else writeHtml(res, status, renderLoginPage({ action: LOGIN_PATH, next: '/', error: message }))
        return
      }
      const next = safeReturnPath(submitted.next)
      const key = submitted.apiKey?.trim() ?? ''
      if (key.length === 0) {
        const message = 'Enter your LiteLLM virtual key.'
        if (style === 'json') writeJson(res, 400, { error: message })
        else writeHtml(res, 400, renderLoginPage({ action: LOGIN_PATH, next, error: message }))
        return
      }

      let identity: LiteLlmKeyIdentity | undefined
      try {
        identity = await client.verifyKey(key)
      } catch (error) {
        const refusal = signInRefusal(error)
        ctx.logger.warn('litellm-auth: key verification failed (%s)', refusal.status)
        if (style === 'json') writeJson(res, refusal.status, { error: refusal.message })
        else writeHtml(res, refusal.status, renderLoginPage({ action: LOGIN_PATH, next, error: refusal.message }))
        return
      }
      if (identity === undefined) {
        const message = 'The proxy accepted that key but names no user for it, so it cannot own a workspace.'
        if (style === 'json') writeJson(res, 403, { error: message })
        else writeHtml(res, 403, renderLoginPage({ action: LOGIN_PATH, next, error: message }))
        return
      }

      const principal = principalOf(identity, key)
      const cookie = sessionCookie(
        resolved.cookieName, sessions.create(principal), maxAgeSeconds, resolved.secureCookie,
      )
      ctx.logger.info('litellm-auth: %s signed in', principal.id)
      if (style === 'json') writeJson(res, 200, sessionView(principal), cookie)
      else writeRedirect(res, next, cookie)
    },

    signOut: (req, res) => {
      if (!isSameSiteRequest(req)) {
        res.writeHead(403, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      const token = readCookie(req.headers.cookie, resolved.cookieName)
      if (token !== undefined) sessions.destroy(token)
      const cleared = sessionCookie(resolved.cookieName, '', 0, resolved.secureCookie)
      if (requestStyle(req) === 'json') writeJson(res, 200, { signedOut: true }, cleared)
      else writeRedirect(res, LOGIN_PATH, cleared)
    },

    session: (req, res) => {
      const principal = service.authenticate(req)
      if (principal === undefined) writeJson(res, 401, { error: 'not signed in' })
      else writeJson(res, 200, sessionView(principal))
    },
  }

  const method = (
    allowed: readonly string[],
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    /* v8 ignore next -- `?? ''` arm: node:http always sets method on server
    requests; the field is only optional on the client-side IncomingMessage type */
    if (!allowed.includes(req.method ?? '')) {
      res.writeHead(405, { 'allow': allowed.join(', '), 'cache-control': 'no-store' })
      res.end()
      return
    }
    await handler(req, res)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: LOGIN_PATH,
    handler: async (req, res) => {
      await (req.method === 'POST' ? routes.signIn(req, res) : method(['GET', 'HEAD'], routes.page)(req, res))
    },
  }), `litellm-auth: ${LOGIN_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: LOGOUT_PATH,
    handler: method(['POST'], routes.signOut),
  }), `litellm-auth: ${LOGOUT_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SESSION_PATH,
    handler: method(['GET', 'HEAD'], routes.session),
  }), `litellm-auth: ${SESSION_PATH}`)
}
