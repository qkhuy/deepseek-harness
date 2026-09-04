import { describe, expect, it } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { principalId } from '@deepseek-ai/dsh-principal'
import type { Principal } from '@deepseek-ai/dsh-principal'
import {
  LiteLlmSessionStore, principalIdForLiteLlmUser, readCookie, resolveBaseUrl, safeReturnPath, sessionCookie,
} from '../src/index.ts'

const principal = (id: string): Principal => ({
  id: principalId(id), displayName: id, secret: `sk-${id}`, models: [],
})

describe('readCookie', () => {
  it('reads the exact name out of a multi-cookie header', () => {
    expect(readCookie('a=1; dsh-litellm-session=tok; b=2', 'dsh-litellm-session')).toBe('tok')
    expect(readCookie('dsh-litellm-session=tok', 'dsh-litellm-session')).toBe('tok')
  })

  it('does not match a name by prefix or suffix', () => {
    expect(readCookie('xdsh-litellm-session=tok', 'dsh-litellm-session')).toBeUndefined()
    expect(readCookie('dsh-litellm-session-old=tok', 'dsh-litellm-session')).toBeUndefined()
  })

  it('answers undefined for an absent header, absent cookie, or cleared value', () => {
    expect(readCookie(undefined, 'x')).toBeUndefined()
    expect(readCookie('a=1', 'x')).toBeUndefined()
    expect(readCookie('x=', 'x')).toBeUndefined()
    expect(readCookie('novalue', 'x')).toBeUndefined()
  })
})

describe('sessionCookie', () => {
  it('keeps the token out of page script and off cross-site posts', () => {
    const header = sessionCookie('s', 'tok', 3600, false)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Path=/')
    expect(header).not.toContain('Secure')
  })

  it('marks the cookie Secure only where the deployment asked', () => {
    expect(sessionCookie('s', 'tok', 3600, true)).toContain('; Secure')
  })

  it('clears with a zero lifetime', () => {
    expect(sessionCookie('s', '', 0, false)).toContain('s=; Max-Age=0')
  })
})

describe('LiteLlmSessionStore', () => {
  it('resolves a created session to its principal', () => {
    const store = new LiteLlmSessionStore(60_000)
    const alice = principal('alice')
    expect(store.resolve(store.create(alice))?.principal).toBe(alice)
  })

  it('mints unguessable, distinct tokens', () => {
    const store = new LiteLlmSessionStore(60_000)
    const first = store.create(principal('alice'))
    const second = store.create(principal('alice'))
    expect(first).not.toBe(second)
    expect(first.length).toBeGreaterThanOrEqual(42)
  })

  it('keeps one user signed in from two browsers', () => {
    const store = new LiteLlmSessionStore(60_000)
    const alice = principal('alice')
    const first = store.create(alice)
    const second = store.create(alice)
    expect(store.resolve(first)?.principal).toBe(alice)
    expect(store.resolve(second)?.principal).toBe(alice)
  })

  it('stops resolving an expired session and forgets it', () => {
    let now = 1000
    const store = new LiteLlmSessionStore(500, () => now)
    const token = store.create(principal('alice'))
    now = 1499
    expect(store.resolve(token)).toBeDefined()
    now = 1500
    expect(store.resolve(token)).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('sweeps expired sessions when a new one opens', () => {
    let now = 0
    const store = new LiteLlmSessionStore(100, () => now)
    store.create(principal('alice'))
    store.create(principal('bob'))
    expect(store.size).toBe(2)
    now = 200
    store.create(principal('carol'))
    expect(store.size).toBe(1)
  })

  it('closes one session and tolerates closing an unknown token', () => {
    const store = new LiteLlmSessionStore(60_000)
    const token = store.create(principal('alice'))
    store.destroy(token)
    expect(store.resolve(token)).toBeUndefined()
    expect(() => { store.destroy('never-issued') }).not.toThrow()
  })

  it('clears every session so none outlives the mount', () => {
    const store = new LiteLlmSessionStore(60_000)
    const token = store.create(principal('alice'))
    store.clear()
    expect(store.resolve(token)).toBeUndefined()
  })
})

describe('principalIdForLiteLlmUser', () => {
  it('derives the same id for the same proxy user every time', () => {
    expect(principalIdForLiteLlmUser('alice@example.com'))
      .toBe(principalIdForLiteLlmUser('alice@example.com'))
  })

  it('keeps a readable slug of the proxy id', () => {
    expect(principalIdForLiteLlmUser('alice@example.com')).toMatch(/^alice-example-com-[0-9a-f]{16}$/)
  })

  it('separates users whose slugs collide', () => {
    expect(principalIdForLiteLlmUser('alice@a.com')).not.toBe(principalIdForLiteLlmUser('alice@b.com'))
  })

  it('addresses a user whose id reduces to nothing readable', () => {
    expect(principalIdForLiteLlmUser('世界')).toMatch(/^user-[0-9a-f]{16}$/)
    expect(principalIdForLiteLlmUser('...')).toMatch(/^user-[0-9a-f]{16}$/)
  })

  it('bounds a very long proxy id to an addressable id', () => {
    const derived = principalIdForLiteLlmUser('x'.repeat(500))
    expect(derived.length).toBeLessThanOrEqual(128)
    expect(derived).toMatch(/^[a-z0-9][a-z0-9_-]*$/)
  })
})

describe('safeReturnPath', () => {
  it('keeps a rooted same-origin path', () => {
    expect(safeReturnPath('/workspaces/1')).toBe('/workspaces/1')
    expect(safeReturnPath('/')).toBe('/')
  })

  it('refuses every spelling that would leave this origin', () => {
    for (const hostile of [
      '//evil.example', 'https://evil.example', 'http://evil.example', '/\\evil.example',
      'evil.example', undefined, '', 'javascript:alert(1)',
    ]) {
      expect(safeReturnPath(hostile)).toBe('/')
    }
  })
})

describe('resolveBaseUrl', () => {
  it('falls back to $LITELLM_BASE_URL when the config omits baseURL', () => {
    const environment = createLaunchEnvironmentSnapshot([
      { source: 'process', values: { LITELLM_BASE_URL: 'https://env.example' } },
    ])
    expect(resolveBaseUrl({}, environment)).toBe('https://env.example')
  })

  it('prefers an explicitly configured baseURL over the environment', () => {
    const environment = createLaunchEnvironmentSnapshot([
      { source: 'process', values: { LITELLM_BASE_URL: 'https://env.example' } },
    ])
    expect(resolveBaseUrl({ baseURL: 'https://configured.example' }, environment)).toBe('https://configured.example')
  })

  it('throws with neither a configured baseURL nor the environment variable', () => {
    const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }])
    expect(() => resolveBaseUrl({}, environment)).toThrow(/no proxy endpoint/)
    expect(() => resolveBaseUrl({})).toThrow(/no proxy endpoint/)
  })
})
