/**
 * Public type vocabulary of the principal seam: the {@link PrincipalId} brand,
 * the {@link Principal} record, and the request view a provider authenticates.
 * Types only — the branding factory lives in `index.ts`.
 * @module @deepseek-ai/dsh-principal/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Identifies one authenticated end user across a deployment. The value is
 * chosen by the authenticating provider and must be stable for the lifetime of
 * the account it names: it addresses that user's durable data (workspaces,
 * per-user roots), so reissuing it under a new spelling orphans everything the
 * old spelling owns. It is never the credential the user presented.
 */
export type PrincipalId = Branded<'PrincipalId'>

/**
 * One authenticated end user, as every downstream consumer sees them.
 *
 * `secret` is the credential the user authenticated with, retained so
 * downstream calls act as that user rather than as the process. It is
 * memory-only: no consumer may log it, write it to a session event, or place
 * it in a durable record, because the session log and every settings document
 * are readable by whoever holds the harness home.
 */
export interface Principal {
  /** Stable durable-data address for this user. */
  readonly id: PrincipalId
  /** Human-readable label for UI surfaces; never used for addressing. */
  readonly displayName: string
  /**
   * The credential this principal authenticated with, for acting as them
   * upstream. Memory-only; never logged, persisted, or sent to a surface.
   */
  readonly secret: string
  /**
   * Model ids this principal may request, in provider-preferred order. An
   * empty array states the authenticating provider imposes no model
   * restriction, not that no model is allowed.
   */
  readonly models: readonly string[]
}

/**
 * The request facts a provider authenticates. This is the intersection of
 * `node:http`'s `IncomingMessage` and Fetch's `Request` that authentication
 * needs, so a provider serves both carriers without importing either.
 */
export interface PrincipalRequest {
  /**
   * Request headers, either carrier's representation. The record form is
   * readonly because a carrier hands over the live request's own header table
   * and authentication must not write to it.
   */
  readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
}
