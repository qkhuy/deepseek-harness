/**
 * Service Definition for the authenticated-principal capability seam
 * (`ctx.principal`). One question is answered here: whose work is this?
 *
 * The seam has two faces because the answer arrives at a carrier and is needed
 * far from it. {@link PrincipalService.authenticate} reads an inbound HTTP
 * request and names the user behind it; {@link PrincipalService.run} binds that
 * user to an async region so every plugin the request reaches — an LLM adapter
 * choosing which key to send, a workspace registry deciding which records are
 * visible — reads the same principal without threading a parameter through
 * seams that have no business naming a user.
 *
 * Absence is meaningful and is the shipped local posture: with no provider
 * mounted, `ctx.get('principal')` is `undefined` and every consumer keeps its
 * single-user behavior. A consumer therefore treats the seam as optional and
 * never fails for want of it.
 *
 * @module @deepseek-ai/dsh-principal
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Principal, PrincipalId, PrincipalRequest } from './types.ts'

export type { Principal, PrincipalId, PrincipalRequest } from './types.ts'

/** A principal id must address a directory and a storage key, so it stays in this alphabet. */
const PRINCIPAL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/

declare module '@deepseek-ai/cordis' {
  interface Context {
    principal: PrincipalService
  }
}

/**
 * Brand a raw string as a {@link PrincipalId}.
 *
 * The grammar is narrow because the value is used as a path segment and a
 * storage key: a lowercase identifier of at most 128 characters, no dots and
 * no separators, so no id can traverse out of a per-user root or collide with
 * one under case-insensitive filesystems.
 * @param value - candidate id, already lowercased by its issuer.
 * @returns the branded id.
 * @throws TypeError when the value is outside the addressable grammar.
 */
export function principalId(value: string): PrincipalId {
  if (!PRINCIPAL_ID_PATTERN.test(value)) {
    throw new TypeError(`principal id "${value}" must match ${String(PRINCIPAL_ID_PATTERN)}`)
  }
  return brandString<PrincipalId>(value)
}

/**
 * Whether a raw string could name a principal at all. Consumers deriving an id
 * from somewhere else — an upstream account id, a token claim — ask this before
 * branding, because a value outside the grammar has no user to miss and must
 * read as "cannot be addressed" rather than as a thrown error.
 * @param value - candidate id.
 * @returns true when {@link principalId} would accept it.
 */
export function isPrincipalIdName(value: string): boolean {
  return PRINCIPAL_ID_PATTERN.test(value)
}

/** A consumer required a bound principal and the current async region has none. */
export class PrincipalRequiredError extends Error {
  /**
   * @param consumer - the refusing package or plugin name.
   */
  constructor(readonly consumer: string) {
    super(`${consumer}: no authenticated principal is bound to this call`)
    this.name = 'PrincipalRequiredError'
  }
}

/**
 * Abstract principal service: request authentication plus the ambient binding
 * every downstream consumer reads.
 *
 * The binding half is concrete here rather than left to providers, because two
 * providers with two `AsyncLocalStorage` instances would each be invisible to
 * the other's consumers — the store is the seam's identity, not an
 * implementation choice. Providers implement authentication alone.
 */
export abstract class PrincipalService extends Service {
  /** The one binding store of the seam; see the class contract for why it is not provider-owned. */
  private readonly bound = new AsyncLocalStorage<Principal>()

  /**
   * @param ctx - Context of the providing plugin.
   */
  constructor(ctx: Context) {
    super(ctx, 'principal')
  }

  /**
   * Resolve the user behind one inbound request. Synchronous by contract: the
   * carrier answers a request before any handler runs, so a provider keeps
   * whatever it needs — a signed cookie's secret, a live session table — loaded
   * ahead of time rather than reaching for it per request.
   * @param request - inbound request headers, either carrier's representation.
   * @returns the authenticated principal, or `undefined` when the request carries no valid identity.
   */
  abstract authenticate(request: PrincipalRequest): Principal | undefined

  /**
   * Whether unauthenticated requests must be refused. A deployment serving one
   * trusted operator answers `false` and lets anonymous requests through with
   * no principal bound; a multi-user deployment answers `true` and the carrier
   * refuses before dispatch.
   */
  abstract get required(): boolean

  /**
   * Bind `principal` to `fn` and everything it awaits, then restore the
   * previous binding. Nesting is legal and the innermost binding wins.
   * @param principal - the user to bind.
   * @param fn - the region to run under that binding.
   * @returns whatever `fn` returns.
   */
  run<T>(principal: Principal, fn: () => T): T {
    return this.bound.run(principal, fn)
  }

  /**
   * The principal bound to the current async region.
   * @returns the bound principal, or `undefined` outside any {@link run} region.
   */
  current(): Principal | undefined {
    return this.bound.getStore()
  }

  /**
   * The principal bound to the current async region, or a refusal naming the
   * consumer that needed one. Consumers whose behavior is undefined without a
   * user call this instead of branching on {@link current}.
   * @param consumer - the calling package or plugin name, for the diagnostic.
   * @returns the bound principal.
   * @throws PrincipalRequiredError when no principal is bound.
   */
  require(consumer: string): Principal {
    const principal = this.bound.getStore()
    if (principal === undefined) throw new PrincipalRequiredError(consumer)
    return principal
  }
}

export default PrincipalService
