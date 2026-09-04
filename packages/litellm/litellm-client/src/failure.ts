/**
 * Classification of LiteLLM proxy failures into the harness's provider-neutral
 * codes. The proxy answers for two parties — itself, when it refuses a key or
 * a budget, and the upstream provider it forwards to — and the two need
 * different handling, so the classification reads the proxy's own error type
 * before falling back to the HTTP status.
 * @module @deepseek-ai/dsh-litellm-client/src/failure
 */

/** Provider-neutral codes this package emits; the harness LLM seam routes on them. */
export type LiteLlmFailureCode =
  | 'AUTH'
  | 'QUOTA'
  | 'RATE_LIMIT'
  | 'BAD_REQUEST'
  | 'UNKNOWN_MODEL'
  | 'SERVER'
  | 'TRANSPORT'

/** One classified proxy failure, ready to become an `LlmError`. */
export interface LiteLlmFailure {
  /** The provider-neutral code. */
  readonly code: LiteLlmFailureCode
  /** Human-readable summary, drawn from the proxy's `error.message` when it sent one. */
  readonly message: string
  /** The HTTP status the proxy answered with. */
  readonly status: number
  /** Proxy-requested delay in milliseconds, from `Retry-After`, when valid. */
  readonly retryAfterMs?: number
}

/**
 * LiteLLM budget refusals arrive as HTTP 400 with a distinctive message rather
 * than as 402 or 429, so a status-only reading would retry a request that can
 * never succeed. These are the substrings the proxy uses for exceeded budgets
 * and for a key it has disabled.
 */
const BUDGET_MARKERS = ['budget has been exceeded', 'exceeded budget', 'budget_exceeded', 'over budget']

const RATE_LIMIT_MARKERS = ['rate limit', 'rate_limit', 'tpm limit', 'rpm limit', 'max parallel request']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the proxy's error message out of a response body.
 *
 * LiteLLM nests it three ways across versions and code paths — `{error:
 * {message}}`, `{detail: {error: {message}}}`, and a bare `{detail: string}` —
 * and an upstream provider's own body passes through unchanged, so all four
 * are read here rather than at each call site.
 * @param body - the parsed JSON body, or the raw text when it was not JSON.
 * @returns the message, or `undefined` when the body carries none.
 */
export function liteLlmErrorMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.length === 0 ? undefined : body
  if (!isRecord(body)) return undefined
  const direct = isRecord(body.error) ? body.error.message : undefined
  if (typeof direct === 'string') return direct
  const detail = body.detail
  if (typeof detail === 'string') return detail
  if (isRecord(detail) && isRecord(detail.error) && typeof detail.error.message === 'string') {
    return detail.error.message
  }
  return undefined
}

/**
 * Parse one `Retry-After` header value into milliseconds.
 *
 * Both RFC 9110 spellings are accepted: delay-seconds, and an HTTP-date the
 * proxy or an upstream provider sends. A date already in the past yields no
 * delay rather than a negative one.
 * @param header - the raw header value, or `undefined` when absent.
 * @param now - current epoch milliseconds, for the HTTP-date form.
 * @returns the delay in milliseconds, or `undefined` when absent or unusable.
 */
export function retryAfterMs(header: string | undefined, now: number): number | undefined {
  if (header === undefined) return undefined
  const trimmed = header.trim()
  if (trimmed.length === 0) return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.round(seconds * 1000) : undefined
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return at > now ? at - now : undefined
}

/**
 * Classify one proxy response into a provider-neutral failure.
 * @param status - the HTTP status the proxy answered with.
 * @param body - the parsed JSON body, or the raw text when it was not JSON.
 * @param retryAfter - the response's `Retry-After` header, when present.
 * @param now - current epoch milliseconds, for the HTTP-date `Retry-After` form.
 * @returns the classified failure.
 */
export function classifyLiteLlmFailure(
  status: number,
  body: unknown,
  retryAfter?: string,
  now: number = Date.now(),
): LiteLlmFailure {
  const message = liteLlmErrorMessage(body) ?? `LiteLLM proxy answered HTTP ${String(status)}`
  const delay = retryAfterMs(retryAfter, now)
  const lowered = message.toLowerCase()
  const code = ((): LiteLlmFailureCode => {
    // Message markers outrank the status: LiteLLM reports both an exceeded
    // budget and an exhausted TPM/RPM allowance as HTTP 400, and a caller that
    // read only the status would retry the first forever and give up on the
    // second immediately.
    if (BUDGET_MARKERS.some(marker => lowered.includes(marker))) return 'QUOTA'
    if (RATE_LIMIT_MARKERS.some(marker => lowered.includes(marker))) return 'RATE_LIMIT'
    if (status === 401 || status === 403) return 'AUTH'
    if (status === 402) return 'QUOTA'
    if (status === 429) return 'RATE_LIMIT'
    if (status === 404) return 'UNKNOWN_MODEL'
    if (status >= 500) return 'SERVER'
    if (status >= 400) return 'BAD_REQUEST'
    return 'SERVER'
  })()
  return {
    code,
    message,
    status,
    ...delay === undefined ? {} : { retryAfterMs: delay },
  }
}
