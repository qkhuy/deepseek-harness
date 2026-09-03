/**
 * The LiteLLM provider route for the harness LLM seam.
 *
 * The package exists for one behavior the configuration-only route through a
 * generic OpenAI-compatible adapter cannot provide: **a request is
 * authenticated as the user who made it.** When `ctx.principal` names a
 * signed-in user, that user's own LiteLLM virtual key is the key on the wire,
 * so the proxy enforces their model access and budget and records the spend
 * against them. The configured `apiKeyEnv` reference is the fallback for work
 * no user made — a scheduled job, a CLI run — and never overrides a signed-in
 * user's key.
 *
 * Model discovery follows the same rule: the catalog a surface shows is the
 * one the requesting user's key may use, read from the proxy per user rather
 * than declared once in configuration.
 *
 * @module @deepseek-ai/dsh-llm-litellm
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, assertUsableApiKey, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { LiteLlmClient, LiteLlmRequestError } from '@deepseek-ai/dsh-litellm-client'
import type { LiteLlmModel } from '@deepseek-ai/dsh-litellm-client'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-principal'
import type {} from '@deepseek-ai/dsh-settings'
import { LiteLlmAdapter } from './adapter.ts'
import type { LiteLlmConnection } from './adapter.ts'

export { LiteLlmAdapter } from './adapter.ts'
export type { LiteLlmAdapterOptions, LiteLlmConnection } from './adapter.ts'
export { serializeMessages, serializeTools } from './serialize.ts'
export type { WireMessage, WireToolCall } from './serialize.ts'
export { BlockWriter, finishReason, tokenUsage } from './stream.ts'

/** Cordis plugin name. */
export const name = 'llm-litellm'
/** The LLM seam must exist before a route can register on it. */
export const inject = ['llm']

/** The provider route this plugin registers. */
export const PROVIDER = 'litellm'
/** Settings namespace this plugin's section is written under. */
export const SETTINGS_NS = 'llm-litellm'
/** Credential reference used when no signed-in user owns the request. */
const DEFAULT_API_KEY_ENV = 'LITELLM_API_KEY'

/**
 * Plugin config. `apiKeyEnv` is deliberately not the primary credential: it
 * serves requests no principal made, and a signed-in user's key always wins.
 */
export interface Config {
  /** LiteLLM proxy URL, with or without a `/v1` suffix. Required. */
  baseURL: string
  /**
   * Credential reference for requests no signed-in user made. Resolved per
   * request through the credential seam, so no secret enters configuration.
   * @default 'LITELLM_API_KEY'
   */
  apiKeyEnv?: string
  /** Model-request timeout in milliseconds. @default 600000 */
  timeoutMs?: number
  /** Timeout in milliseconds for each catalog read. @default 15000 */
  catalogTimeoutMs?: number
  /** How long a per-user catalog stays cached, in seconds. @default 300 */
  catalogTtlSeconds?: number
  /** Context capacity assumed for a model the proxy does not size. @default 128000 */
  defaultContextWindow?: number
  /** Extra headers merged into every proxy request, for deployment routing. */
  headers?: Record<string, string>
  /** Route-owned retry policy executed by `dsh-llm-retry`. */
  retryPolicy?: RetryPolicyConfig
}

export const Config: z<Config> = z.object({
  baseURL: z.string().required(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  timeoutMs: z.natural().min(1).default(600_000),
  catalogTimeoutMs: z.natural().min(1).default(15_000),
  catalogTtlSeconds: z.natural().default(300),
  defaultContextWindow: z.natural().min(1).default(128_000),
  headers: z.dict(z.string()).default({}),
  retryPolicy: z.any().description('Route-owned retry policy; see dsh-llm retry-policy.') as z<RetryPolicyConfig>,
})

/** One cached catalog read, keyed by the identity whose key produced it. */
interface CatalogEntry {
  readonly models: Promise<readonly LiteLlmModel[]>
  readonly readAt: number
}

/**
 * Per-identity catalog cache.
 *
 * The cache is keyed by principal id — never by key — because two users of one
 * proxy legitimately see different catalogs, and a process-wide cache would
 * show whichever of them asked first to everyone after. The `anonymous` key
 * holds the configured fallback credential's catalog.
 */
class CatalogCache {
  private readonly entries = new Map<string, CatalogEntry>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Read one identity's catalog, refreshing it when the cached copy aged out.
   * @param identity - principal id, or `anonymous` for the configured fallback.
   * @param read - the proxy read to perform on a miss.
   * @returns the models that identity may use.
   */
  async read(identity: string, read: () => Promise<readonly LiteLlmModel[]>): Promise<readonly LiteLlmModel[]> {
    const cached = this.entries.get(identity)
    if (cached !== undefined && this.now() - cached.readAt < this.ttlMs) return await cached.models
    const models = read()
    this.entries.set(identity, { models, readAt: this.now() })
    try {
      return await models
    } catch (error) {
      // A failed read must not be cached: the next request would answer from a
      // rejected promise until the TTL elapsed, turning one proxy hiccup into
      // minutes of empty model lists.
      this.entries.delete(identity)
      throw error
    }
  }

  /** Forget every cached catalog; the plugin disposer calls this. */
  clear(): void {
    this.entries.clear()
  }
}

/**
 * Mount the LiteLLM provider route.
 * @param ctx - the plugin Context; the route registration binds to it.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Omit<Config, 'headers' | 'retryPolicy'>>
    & { headers: Record<string, string>; retryPolicy?: RetryPolicyConfig }
  const ref = credentialRef(resolved.apiKeyEnv)
  const catalogs = new CatalogCache(resolved.catalogTtlSeconds * 1000)
  const client = new LiteLlmClient({
    baseURL: resolved.baseURL,
    timeoutMs: resolved.catalogTimeoutMs,
    headers: resolved.headers,
  })

  ctx.effect(() => () => {
    catalogs.clear()
  }, 'llm-litellm: catalog cache')

  const connection = (): LiteLlmConnection => ({
    baseURL: resolved.baseURL,
    timeoutMs: resolved.timeoutMs,
    headers: resolved.headers,
    defaultContextWindow: resolved.defaultContextWindow,
  })

  /**
   * The credential this request acts as. The signed-in user's key outranks the
   * configured reference — that ordering IS the package's contract, so it is
   * stated here once and nowhere else.
   */
  const resolveApiKey = async (): Promise<string> => {
    const principal = ctx.get('principal')?.current()
    if (principal !== undefined) return assertUsableApiKey(principal.secret, 'llm-litellm', 'the signed-in session')
    const credentials = ctx.get('credentials')
    const hit = await credentials?.resolve(ref)
    if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-litellm', ref)
    throw new LlmError(
      `llm-litellm: no key for provider route "${PROVIDER}"; sign in with a LiteLLM virtual key, or store`
      + ` ${ref} through the credentials service for requests no signed-in user makes`,
      'MISSING_CREDENTIAL',
    )
  }

  const listCatalog = async (): Promise<readonly LiteLlmModel[]> => {
    const principal = ctx.get('principal')?.current()
    const key = await resolveApiKey()
    try {
      return await catalogs.read(principal?.id ?? 'anonymous', () => client.listModels(key))
    } catch (error) {
      if (!(error instanceof LiteLlmRequestError)) throw error
      // The catalog is advisory: a proxy that will not list models can still
      // serve the model a caller named, so a failed listing degrades to an
      // empty catalog with a diagnostic rather than failing model selection.
      ctx.logger.warn('llm-litellm: the proxy would not list models (%s)', error.failure.code)
      return []
    }
  }

  // Resolved at load so a malformed policy fails the mount rather than the
  // first request the route serves.
  const retryPolicy = resolveRetryPolicy(resolved.retryPolicy, 'llm-litellm: retryPolicy')
  const adapter = new LiteLlmAdapter({ connection, resolveApiKey, listCatalog, retryPolicy })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'LiteLLM', settingsNs: SETTINGS_NS, settingsPath: [] },
  ])
  // Route registration binds to this apply fiber through the stable `ctx`
  // reference the seam captured.
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
