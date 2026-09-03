/**
 * Derivation of a harness {@link PrincipalId} from a LiteLLM user id.
 *
 * The proxy's user ids are whatever its operator issued — a UUID, an email
 * address, an SSO subject — while a principal id addresses a directory and a
 * storage key, so the two vocabularies cannot be the same string. The
 * derivation is a pure function of the proxy id, because the id addresses
 * durable per-user data: the same LiteLLM user must resolve to the same
 * principal on every sign-in, in every process, for the life of the account.
 *
 * @module @deepseek-ai/dsh-litellm-auth/src/principal-id
 */

import { createHash } from 'node:crypto'
import { principalId } from '@deepseek-ai/dsh-principal'
import type { PrincipalId } from '@deepseek-ai/dsh-principal'

/** Readable prefix length; the suffix, not this, is what makes the id unique. */
const SLUG_LIMIT = 32

/** Hex digest length. 64 bits: collision-free for any realistic user population. */
const DIGEST_LENGTH = 16

/**
 * Derive the stable principal id of one LiteLLM user.
 *
 * The result is a readable slug of the proxy id joined to a digest of that id
 * in full. The slug alone would collide — `alice@a.com` and `alice@b.com`
 * reduce to the same characters — and the digest alone would make every
 * per-user directory unreadable, so both are kept and the digest is what
 * carries uniqueness.
 * @param liteLlmUserId - the proxy's own user id, verbatim.
 * @returns the branded principal id.
 */
export function principalIdForLiteLlmUser(liteLlmUserId: string): PrincipalId {
  const slug = liteLlmUserId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, SLUG_LIMIT)
    .replaceAll(/-+$/gu, '')
  const digest = createHash('sha256').update(liteLlmUserId).digest('hex').slice(0, DIGEST_LENGTH)
  // An id reducing to nothing addressable — punctuation only, or a
  // non-Latin-script name — still needs a readable leading segment.
  return principalId(`${slug.length === 0 ? 'user' : slug}-${digest}`)
}
