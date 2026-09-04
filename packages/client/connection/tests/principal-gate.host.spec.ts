/**
 * What a mounted principal seam changes at the Connection carrier: who /api
 * accepts, who may load the application document, and which user the request's
 * handling runs as.
 */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { PrincipalService, principalId } from '@deepseek-ai/dsh-principal'
import type { Principal, PrincipalRequest } from '@deepseek-ai/dsh-principal'
import { API_PATH, apply, inject, type HostConnectionHandle } from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

const alice: Principal = {
  id: principalId('alice'), displayName: 'Alice', secret: 'sk-alice', models: [],
}

/** A seam that recognizes exactly one session cookie value. */
class CookiePrincipals extends PrincipalService {
  constructor(ctx: Context, private readonly config: { required: boolean; signInUrl?: string }) {
    super(ctx)
  }

  override get required(): boolean { return this.config.required }

  override get signInUrl(): string | undefined { return this.config.signInUrl }

  override authenticate(request: PrincipalRequest): Principal | undefined {
    const { headers } = request
    const cookie = headers instanceof Headers ? headers.get('cookie') : headers.cookie
    return cookie === 'session=alice' ? alice : undefined
  }
}

function fakeHttpServer(routes: WebRoute[]): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route: WebUpgradeRoute) { return () => void route },
    tapIndex: () => () => {},
    port: 0,
  }
}

function fakeRequest(headers: Record<string, string>, url = '/'): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'GET', headers })
  return request
}

function fakeResponse(): { response: ServerResponse; state: { status?: number; headers?: Record<string, string> } } {
  const state: { status?: number; headers?: Record<string, string> } = {}
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number, headers?: Record<string, string>) {
      state.status = value
      if (headers !== undefined) state.headers = headers
      return this
    },
    write() { return true },
    end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
  }) as unknown as ServerResponse
  return { response, state }
}

async function mounted(options: { principal?: 'required' | 'optional'; signInUrl?: string } = {}): Promise<{
  connection: HostConnectionHandle
  routes: WebRoute[]
  ctx: Context
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  provideBrowserCredentials(ctx)
  ctx.provide('webServer', fakeHttpServer(routes) as WebServer)
  if (options.principal !== undefined) {
    await ctx.plugin(CookiePrincipals, {
      required: options.principal === 'required',
      ...options.signInUrl === undefined ? {} : { signInUrl: options.signInUrl },
    })
  }
  const fiber = ctx.plugin({ inject: [...inject], apply }, {})
  await fiber.await()
  return {
    connection: ctx.get('connection') as HostConnectionHandle,
    routes,
    ctx,
    dispose: () => fiber.dispose(),
  }
}

describe('with no principal seam mounted', () => {
  it('keeps the launch-token browser session as the only authentication', async () => {
    const { connection, dispose } = await mounted()
    expect(connection.requestRejection(fakeRequest({ host: '127.0.0.1:3080' }, API_PATH))).toBe(401)
    await dispose()
  })

  it('runs the request with no principal bound', async () => {
    const { connection, dispose } = await mounted()
    expect(connection.runAuthenticated(fakeRequest({ host: '127.0.0.1:3080' }), () => 'ran')).toBe('ran')
    await dispose()
  })
})

describe('with a principal seam mounted', () => {
  it('accepts an /api request carrying a live session', async () => {
    const { connection, dispose } = await mounted({ principal: 'required' })
    expect(connection.requestRejection(
      fakeRequest({ 'host': '127.0.0.1:3080', 'cookie': 'session=alice' }, API_PATH),
    )).toBeUndefined()
    await dispose()
  })

  it('refuses an /api request with no session', async () => {
    const { connection, dispose } = await mounted({ principal: 'required' })
    expect(connection.requestRejection(fakeRequest({ host: '127.0.0.1:3080' }, API_PATH))).toBe(401)
    await dispose()
  })

  it('does not ask for a launch token the deployment cannot distribute', async () => {
    const { connection, dispose } = await mounted({ principal: 'required' })
    // The signed-in cookie alone admits the request: no browser-session cookie
    // was ever exchanged for this context.
    expect(connection.requestRejection(
      fakeRequest({ 'host': '127.0.0.1:3080', 'cookie': 'session=alice' }, API_PATH),
    )).toBeUndefined()
    await dispose()
  })

  it('keeps the Host fence ahead of authentication', async () => {
    const { connection, dispose } = await mounted({ principal: 'required' })
    expect(connection.requestRejection(
      fakeRequest({ 'host': 'evil.example', 'cookie': 'session=alice' }, API_PATH),
    )).toBe(403)
    await dispose()
  })

  it('lets an anonymous request through where the deployment does not require sign-in', async () => {
    const { connection, dispose } = await mounted({ principal: 'optional' })
    expect(connection.requestRejection(fakeRequest({ host: '127.0.0.1:3080' }, API_PATH))).toBeUndefined()
    await dispose()
  })

  it('serves the application document to a browser with no identity yet, absent a sign-in page', async () => {
    const { connection, dispose } = await mounted({ principal: 'required' })
    const { response, state } = fakeResponse()
    expect(connection.authorizeIndex(fakeRequest({ host: '127.0.0.1:3080' }), response)).toBe(true)
    expect(state.status).toBeUndefined()
    await dispose()
  })

  it('redirects an unauthenticated browser to the seam\'s own sign-in page, carrying the requested path', async () => {
    const { connection, dispose } = await mounted({ principal: 'required', signInUrl: '/auth/litellm' })
    const { response, state } = fakeResponse()
    expect(connection.authorizeIndex(fakeRequest({ host: '127.0.0.1:3080' }, '/w/1'), response)).toBe(false)
    expect(state.status).toBe(303)
    expect(state.headers?.location).toBe('/auth/litellm?next=%2Fw%2F1')
    expect(state.headers?.['cache-control']).toBe('no-store')
    await dispose()
  })

  it('serves the application document straight through to a browser that already has a session', async () => {
    const { connection, dispose } = await mounted({ principal: 'required', signInUrl: '/auth/litellm' })
    const { response, state } = fakeResponse()
    expect(connection.authorizeIndex(
      fakeRequest({ 'host': '127.0.0.1:3080', 'cookie': 'session=alice' }), response,
    )).toBe(true)
    expect(state.status).toBeUndefined()
    await dispose()
  })

  it('serves the application document where the deployment does not require sign-in, sign-in page or not', async () => {
    const { connection, dispose } = await mounted({ principal: 'optional', signInUrl: '/auth/litellm' })
    const { response, state } = fakeResponse()
    expect(connection.authorizeIndex(fakeRequest({ host: '127.0.0.1:3080' }), response)).toBe(true)
    expect(state.status).toBeUndefined()
    await dispose()
  })

  it('sanitizes an off-origin request path rather than forwarding it into the sign-in redirect', async () => {
    const { connection, dispose } = await mounted({ principal: 'required', signInUrl: '/auth/litellm' })
    const { response, state } = fakeResponse()
    connection.authorizeIndex(fakeRequest({ host: '127.0.0.1:3080' }, '//evil.example'), response)
    expect(state.headers?.location).toBe('/auth/litellm?next=%2F')
    await dispose()
  })

  it('sanitizes a backslash path a WHATWG-parsing browser would resolve off-origin', async () => {
    const { connection, dispose } = await mounted({ principal: 'required', signInUrl: '/auth/litellm' })
    const { response, state } = fakeResponse()
    connection.authorizeIndex(fakeRequest({ host: '127.0.0.1:3080' }, '/\\evil.example'), response)
    expect(state.headers?.location).toBe('/auth/litellm?next=%2F')
    await dispose()
  })

  it('binds the signed-in user to the request handling', async () => {
    const { connection, ctx, dispose } = await mounted({ principal: 'required' })
    const seen = connection.runAuthenticated(
      fakeRequest({ 'host': '127.0.0.1:3080', 'cookie': 'session=alice' }),
      () => ctx.principal.current(),
    )
    expect(seen).toBe(alice)
    expect(ctx.principal.current()).toBeUndefined()
    await dispose()
  })

  it('binds nobody when the request carries no session', async () => {
    const { connection, ctx, dispose } = await mounted({ principal: 'optional' })
    expect(connection.runAuthenticated(
      fakeRequest({ host: '127.0.0.1:3080' }),
      () => ctx.principal.current(),
    )).toBeUndefined()
    await dispose()
  })

  it('binds the user around the /api route handler, where downstream work runs', async () => {
    const { connection, routes, ctx, dispose } = await mounted({ principal: 'required' })
    let boundInsideHandler: string | undefined
    connection.fetch.register({
      path: `${API_PATH}/whoami`,
      methods: ['GET'],
      fetch: () => {
        boundInsideHandler = ctx.principal.current()?.id
        return Promise.resolve(new Response('{}'))
      },
    })
    const api = routes.find(route => route.path === API_PATH)!
    await api.handler(
      fakeRequest({ 'host': '127.0.0.1:3080', 'cookie': 'session=alice' }, `${API_PATH}/whoami`),
      fakeResponse().response,
    )
    expect(boundInsideHandler).toBe('alice')
    await dispose()
  })
})
