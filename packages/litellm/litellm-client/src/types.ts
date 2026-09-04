/**
 * The LiteLLM proxy management-API values this package reads, expressed as the
 * fields the harness actually consumes. Every field is optional on the wire —
 * a proxy's `/key/info` payload varies with its database schema and version —
 * so parsing narrows rather than validates a fixed document.
 * @module @deepseek-ai/dsh-litellm-client/src/types
 */

/**
 * Who one LiteLLM virtual key belongs to and what it may spend.
 *
 * The key itself is never a field here: this record travels to configuration
 * surfaces and diagnostics, and a key that reached either would be a leak.
 */
export interface LiteLlmKeyIdentity {
  /**
   * The proxy's own user id for this key. A key issued without one falls back
   * to its team id and then to its alias, because the harness addresses a
   * user's durable data by this value and cannot leave it blank.
   */
  readonly userId: string
  /** The key's human-readable alias, when the proxy issued one. */
  readonly keyAlias?: string
  /** The proxy's team id for this key, when it belongs to a team. */
  readonly teamId?: string
  /**
   * Model ids this key may request. Empty states the key is unrestricted —
   * LiteLLM spells that as an absent or empty `models` list — not that the key
   * can request nothing.
   */
  readonly models: readonly string[]
  /** Hard spend ceiling in USD, when the key carries one. */
  readonly maxBudget?: number
  /** Spend accrued against this key in USD, when the proxy reports it. */
  readonly spend?: number
  /** ISO-8601 expiry instant, when the key carries one. */
  readonly expiresAt?: string
}

/** One model the proxy serves, as `/model/info` and `/v1/models` describe it. */
export interface LiteLlmModel {
  /** The id a request names in `model`; LiteLLM's public alias, not the upstream model. */
  readonly id: string
  /** Display label, defaulting to {@link id} when the proxy names none. */
  readonly name: string
  /** Upstream provider the proxy routes this model to, when it discloses one. */
  readonly provider?: string
  /** Maximum input tokens, when the proxy declares one. */
  readonly contextWindow?: number
  /** Maximum output tokens, when the proxy declares one. */
  readonly maxOutputTokens?: number
  /** Whether the proxy declares this model accepts image input. */
  readonly supportsVision?: boolean
  /** Whether the proxy declares this model emits reasoning content. */
  readonly supportsReasoning?: boolean
}
