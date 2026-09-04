/**
 * The signed-in session table and its cookie encoding.
 *
 * Sessions are process-memory only and their tokens are opaque 256-bit random
 * values looked up in this table — there is no signed payload to verify,
 * because a value that is only ever compared against a table entry carries no
 * claims to forge. The consequence is deliberate and documented: restarting the
 * harness signs everyone out. The alternative, a durable signed cookie, would
 * have to durably hold each user's LiteLLM key to keep serving their requests
 * after a restart, and this package never writes a key to disk.
 *
 * @module @deepseek-ai/dsh-litellm-auth/src/session
 */

import { randomBytes } from 'node:crypto'
import type { Principal } from '@deepseek-ai/dsh-principal'

/** Token entropy in bytes; 256 bits, so an online guess is not a threat model. */
const TOKEN_BYTES = 32

/** One signed-in session: who, and until when. */
export interface LiteLlmSession {
  /** The authenticated user, carrying the key their requests act as. */
  readonly principal: Principal
  /** Epoch milliseconds after which this session no longer authenticates. */
  readonly expiresAt: number
}

/** Base64url without padding: cookie-safe and URL-safe with no escaping. */
function randomToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * Read one cookie by exact name out of a `Cookie` header.
 *
 * Only the exact name is matched and only this package's own generated values
 * are read back, so the general Cookie grammar — quoted strings, attributes —
 * is deliberately not implemented.
 * @param header - the raw `Cookie` header value, or `undefined` when absent.
 * @param name - the cookie name to read.
 * @returns the value, or `undefined` when the header carries no such cookie.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    const value = segment.slice(at + 1).trim()
    return value.length === 0 ? undefined : value
  }
  return undefined
}

/**
 * Serialize the session cookie.
 *
 * `HttpOnly` keeps the token out of page script, and `SameSite=Lax` is what
 * lets the browser send it on the top-level navigation that follows sign-in
 * while still withholding it from cross-site form posts. `Secure` is
 * deployment-decided rather than always set, because the shipped Web surface
 * serves plain HTTP over loopback and a `Secure` cookie would never be stored
 * there.
 * @param name - cookie name.
 * @param value - the opaque session token, or the empty string to clear.
 * @param maxAgeSeconds - cookie lifetime; zero clears the cookie.
 * @param secure - whether to set the `Secure` attribute.
 * @returns the `Set-Cookie` header value.
 */
export function sessionCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

/**
 * The live session table. One instance per mounted plugin; sessions do not
 * outlive it.
 */
export class LiteLlmSessionStore {
  private readonly sessions = new Map<string, LiteLlmSession>()

  /**
   * @param ttlMs - session lifetime in milliseconds, applied at creation.
   * @param now - clock reading epoch milliseconds (test hook).
   */
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** How many sessions are currently held, expired ones included until swept. */
  get size(): number {
    return this.sessions.size
  }

  /**
   * Open a session for one authenticated user.
   *
   * A user signing in again gets an additional session rather than replacing
   * their previous one, because the same person signing in from a second
   * browser must not sign the first one out. Expired entries are swept here so
   * the table stays bounded by live sign-ins without a timer.
   * @param principal - the authenticated user.
   * @returns the opaque token to hand the browser.
   */
  create(principal: Principal): string {
    this.sweep()
    const token = randomToken()
    this.sessions.set(token, { principal, expiresAt: this.now() + this.ttlMs })
    return token
  }

  /**
   * Resolve one token to its session.
   *
   * A hash lookup rather than a constant-time comparison: the token is 256
   * bits of `randomBytes`, so the timing a map probe leaks narrows nothing an
   * attacker could then search.
   * @param token - the opaque token from the request cookie.
   * @returns the session, or `undefined` when unknown or expired.
   */
  resolve(token: string): LiteLlmSession | undefined {
    const session = this.sessions.get(token)
    if (session === undefined) return undefined
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token)
      return undefined
    }
    return session
  }

  /**
   * Close one session. Closing an unknown or already-expired token is a no-op,
   * so a sign-out from a stale tab still answers success.
   * @param token - the opaque token to close.
   */
  destroy(token: string): void {
    this.sessions.delete(token)
  }

  /** Close every session; the plugin disposer calls this so no principal outlives the mount. */
  clear(): void {
    this.sessions.clear()
  }

  private sweep(): void {
    const now = this.now()
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token)
    }
  }
}
