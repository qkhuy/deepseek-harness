/**
 * LiteLLM proxy management client: verify one virtual key, read the model
 * catalog that key may use, and classify proxy failures.
 *
 * Everything here acts *as the caller's key*. There is no admin credential and
 * no ambient process key: each method takes the virtual key it should send, so
 * one process serving several signed-in users never mixes their authority. The
 * proxy's own authorization then decides what each key may see — a key's
 * `/model/info` reply already lists only the models that key can request — so
 * the harness never reimplements the proxy's access rules.
 *
 * @module @deepseek-ai/dsh-litellm-client
 */

import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { classifyLiteLlmFailure } from './failure.ts'
import type { LiteLlmFailure } from './failure.ts'
import type { LiteLlmKeyIdentity, LiteLlmModel } from './types.ts'

export { classifyLiteLlmFailure, liteLlmErrorMessage, retryAfterMs } from './failure.ts'
export type { LiteLlmFailure, LiteLlmFailureCode } from './failure.ts'
export type { LiteLlmKeyIdentity, LiteLlmModel } from './types.ts'

/**
 * Environment name carrying the proxy endpoint when no plugin config names
 * one. A deployment fact, not a user preference, so it is read from the
 * launch environment rather than settings.
 */
export const LITELLM_BASE_URL_ENV = 'LITELLM_BASE_URL'

/**
 * Resolve the proxy endpoint two callers share: the configured value, else
 * `$LITELLM_BASE_URL` from a trusted environment layer. The one explicit
 * resolve step from raw config to a usable endpoint — kept here, not
 * duplicated in each mounting plugin, because a future change to the
 * resolution rule (another fallback source, trimming, …) must not drift
 * between them.
 *
 * Deliberately returns `undefined` rather than throwing: each caller states
 * its own missing-endpoint diagnostic in its own error vocabulary (an
 * `LlmError` for the model route, a plain `Error` for the auth plugin), and
 * this function does not own either.
 * @param configuredBaseUrl - the plugin's own `baseURL` config field, verbatim.
 * @param environment - this run's environment layers, or `undefined` outside the product CLI.
 * @returns the resolved endpoint, or `undefined` when neither source names one.
 */
export function resolveLiteLlmBaseUrl(
  configuredBaseUrl: string | undefined,
  environment?: LaunchEnvironmentSnapshot,
): string | undefined {
  const baseURL = configuredBaseUrl ?? environment?.get(LITELLM_BASE_URL_ENV)?.value
  return baseURL === undefined || baseURL.trim().length === 0 ? undefined : baseURL
}

/** A proxy call failed; `failure` carries the classification callers route on. */
export class LiteLlmRequestError extends Error {
  /**
   * @param failure - the classified proxy failure.
   * @param options - optional cause, for a transport error wrapped here.
   */
  constructor(readonly failure: LiteLlmFailure, options?: ErrorOptions) {
    super(failure.message, options)
    this.name = 'LiteLlmRequestError'
  }
}

/** Construction facts for one {@link LiteLlmClient}. */
export interface LiteLlmClientOptions {
  /** Proxy root URL, with or without a trailing slash and with or without a `/v1` suffix. */
  readonly baseURL: string
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number
  /** Fetch implementation; defaults to the global. Tests and proxied deployments replace it. */
  readonly fetch?: typeof globalThis.fetch
  /** Extra headers sent with every management call, for deployment routing. */
  readonly headers?: Readonly<Record<string, string>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A positive finite number, or `undefined` — LiteLLM sends `null` for "no limit". */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** A finite number including zero, for accrued spend. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * LiteLLM spells "this key may use every model" three ways depending on how it
 * was issued: an absent list, an empty list, and the literal `all-proxy-models`
 * wildcard. All three become the empty list, which this package's vocabulary
 * defines as unrestricted.
 */
const MODEL_WILDCARDS = new Set(['all-proxy-models', 'all-team-models', '*'])

function modelList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const ids = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  return ids.some(id => MODEL_WILDCARDS.has(id)) ? [] : ids
}

/**
 * Normalize a configured proxy URL to its API root: no trailing slash, and no
 * trailing `/v1`.
 *
 * Both spellings appear in LiteLLM's own documentation — the OpenAI base URL
 * carries `/v1`, the management endpoints do not — so a deployment that copied
 * either into configuration must reach both. This is the one place the
 * difference is resolved.
 * @param baseURL - the configured URL, verbatim.
 * @returns the API root, without a trailing slash.
 */
export function liteLlmApiRoot(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/u, '')
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed
}

/**
 * The OpenAI-compatible chat-completions URL of one proxy.
 * @param baseURL - the configured proxy URL, in either spelling.
 * @returns the absolute chat-completions endpoint.
 */
export function liteLlmChatCompletionsUrl(baseURL: string): string {
  return `${liteLlmApiRoot(baseURL)}/v1/chat/completions`
}

/**
 * Read one key's identity out of a `/key/info` or `/user/info` payload.
 *
 * The proxy nests the fields under `info` for `/key/info` and under
 * `user_info` for `/user/info`, and older builds return them flat, so all three
 * placements are read. A payload naming no user id at all yields `undefined`:
 * the harness addresses durable per-user data by that id and must refuse a key
 * it cannot address rather than pooling such keys under a shared fallback.
 * @param payload - the parsed response body.
 * @returns the identity, or `undefined` when the payload names no addressable user.
 */
export function parseKeyIdentity(payload: unknown): LiteLlmKeyIdentity | undefined {
  if (!isRecord(payload)) return undefined
  const info = isRecord(payload.info) ? payload.info
    : isRecord(payload.user_info) ? payload.user_info
      : payload
  const keyAlias = nonEmptyString(info.key_alias) ?? nonEmptyString(payload.key_alias)
  const teamId = nonEmptyString(info.team_id) ?? nonEmptyString(payload.team_id)
  const userId = nonEmptyString(info.user_id)
    ?? nonEmptyString(payload.user_id)
    ?? teamId
    ?? keyAlias
  if (userId === undefined) return undefined
  const maxBudget = positiveNumber(info.max_budget)
  const spend = finiteNumber(info.spend)
  const expiresAt = nonEmptyString(info.expires)
  return {
    userId,
    ...keyAlias === undefined ? {} : { keyAlias },
    ...teamId === undefined ? {} : { teamId },
    models: modelList(info.models),
    ...maxBudget === undefined ? {} : { maxBudget },
    ...spend === undefined ? {} : { spend },
    ...expiresAt === undefined ? {} : { expiresAt },
  }
}

/** Read one `/model/info` entry, whose facts live in `model_info` and `litellm_params`. */
function parseModelInfoEntry(entry: unknown): LiteLlmModel | undefined {
  if (!isRecord(entry)) return undefined
  const id = nonEmptyString(entry.model_name) ?? nonEmptyString(entry.id)
  if (id === undefined) return undefined
  const modelInfo = isRecord(entry.model_info) ? entry.model_info : {}
  const params = isRecord(entry.litellm_params) ? entry.litellm_params : {}
  const provider = nonEmptyString(modelInfo.litellm_provider) ?? nonEmptyString(params.custom_llm_provider)
  const contextWindow = positiveNumber(modelInfo.max_input_tokens) ?? positiveNumber(modelInfo.max_tokens)
  const maxOutputTokens = positiveNumber(modelInfo.max_output_tokens)
  return {
    id,
    name: nonEmptyString(modelInfo.display_name) ?? id,
    ...provider === undefined ? {} : { provider },
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxOutputTokens === undefined ? {} : { maxOutputTokens },
    ...typeof modelInfo.supports_vision === 'boolean' ? { supportsVision: modelInfo.supports_vision } : {},
    ...typeof modelInfo.supports_reasoning === 'boolean' ? { supportsReasoning: modelInfo.supports_reasoning } : {},
  }
}

/**
 * Read a model catalog from either listing the proxy serves.
 *
 * `/model/info` answers `{data: [{model_name, model_info, litellm_params}]}`
 * with capacities and capability flags; `/v1/models` answers the OpenAI
 * `{data: [{id}]}` shape with nothing but ids. Both are accepted so a proxy
 * that restricts the management endpoint still yields a usable catalog, and
 * ids are de-duplicated because a proxy listing one model under several
 * deployments repeats its public alias.
 * @param payload - the parsed response body from either endpoint.
 * @returns the models, in the order the proxy listed them.
 */
export function parseModelCatalog(payload: unknown): readonly LiteLlmModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return []
  const byId = new Map<string, LiteLlmModel>()
  for (const entry of payload.data) {
    const model = parseModelInfoEntry(entry)
    if (model !== undefined && !byId.has(model.id)) byId.set(model.id, model)
  }
  return [...byId.values()]
}

/**
 * Management-API client for one LiteLLM proxy. Stateless beyond its endpoint
 * and timeout: every call carries the virtual key it acts as.
 */
export class LiteLlmClient {
  private readonly root: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly headers: Readonly<Record<string, string>>

  /**
   * @param options - endpoint, timeout, and the optional fetch and header overrides.
   */
  constructor(private readonly options: LiteLlmClientOptions) {
    this.root = liteLlmApiRoot(options.baseURL)
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.headers = options.headers ?? {}
  }

  /** The proxy's API root, without a trailing slash or `/v1` suffix. */
  get apiRoot(): string {
    return this.root
  }

  /** The OpenAI-compatible chat-completions endpoint of this proxy. */
  get chatCompletionsUrl(): string {
    return `${this.root}/v1/chat/completions`
  }

  /**
   * Verify one virtual key and read who it belongs to.
   *
   * `/key/info` is asked first because it answers for the exact key presented.
   * A proxy that does not expose it — or exposes it only to admin keys, which
   * answers 401 for an ordinary virtual key — falls back to `/user/info`, whose
   * reply names the same user. A key the proxy rejects at both raises rather
   * than answering `undefined`, so a sign-in surface can tell "wrong key" from
   * "key with no addressable user".
   * @param key - the virtual key to verify and act as.
   * @param signal - cancellation for the verification.
   * @returns the key's identity, or `undefined` when the proxy accepted it but named no addressable user.
   * @throws LiteLlmRequestError when the proxy refused the key or could not be reached.
   */
  async verifyKey(key: string, signal?: AbortSignal): Promise<LiteLlmKeyIdentity | undefined> {
    let firstFailure: LiteLlmRequestError | undefined
    for (const path of ['/key/info', '/user/info']) {
      let payload: unknown
      try {
        payload = await this.request(path, key, signal)
      } catch (error) {
        // Keep the /key/info verdict: it is the one that judged this exact
        // key, so it is the diagnostic a wrong key deserves even when the
        // fallback fails differently.
        firstFailure ??= error as LiteLlmRequestError
        continue
      }
      const identity = parseKeyIdentity(payload)
      if (identity !== undefined) return identity
    }
    if (firstFailure !== undefined) throw firstFailure
    return undefined
  }

  /**
   * List the models one key may request.
   *
   * `/model/info` is asked first for its capacities and capability flags, and
   * `/v1/models` answers when the proxy restricts it. An empty catalog from
   * both is returned as empty rather than raising: a proxy may legitimately
   * serve a key no model, and the caller decides whether that is an error.
   * @param key - the virtual key whose catalog to read.
   * @param signal - cancellation for the listing.
   * @returns the models the proxy listed for this key.
   * @throws LiteLlmRequestError when neither endpoint could be read.
   */
  async listModels(key: string, signal?: AbortSignal): Promise<readonly LiteLlmModel[]> {
    let firstFailure: LiteLlmRequestError | undefined
    for (const path of ['/model/info', '/v1/models']) {
      let payload: unknown
      try {
        payload = await this.request(path, key, signal)
      } catch (error) {
        firstFailure ??= error as LiteLlmRequestError
        continue
      }
      const models = parseModelCatalog(payload)
      if (models.length > 0) return models
    }
    if (firstFailure !== undefined) throw firstFailure
    return []
  }

  /** One authenticated GET against the proxy, with the classified-failure contract both callers rely on. */
  private async request(path: string, key: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await this.fetchImpl(`${this.root}${path}`, {
        method: 'GET',
        headers: { ...this.headers, 'authorization': `Bearer ${key}`, 'accept': 'application/json' },
        signal: composed,
      })
    } catch (error) {
      throw new LiteLlmRequestError({
        code: 'TRANSPORT',
        message: `litellm-client: ${path} could not be reached at ${this.root}`,
        status: 0,
      }, { cause: error })
    }
    const text = await response.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // A non-JSON body is a proxy error page or a misconfigured URL reaching
      // something else; the raw text is what the failure classifier reads.
    }
    if (!response.ok) {
      throw new LiteLlmRequestError(
        classifyLiteLlmFailure(response.status, body, response.headers.get('retry-after') ?? undefined),
      )
    }
    return body
  }
}
