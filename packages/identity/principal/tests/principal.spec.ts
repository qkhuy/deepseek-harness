import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PrincipalRequiredError, isPrincipalIdName, principalId } from '../src/index.ts'
import { MemoryPrincipals, testPrincipal } from './memory.ts'

const alice = testPrincipal('alice')
const bob = testPrincipal('bob')

async function boot(required = false): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryPrincipals, { tokens: { 'tok-alice': alice, 'tok-bob': bob }, required })
  return ctx
}

describe('principalId', () => {
  it('brands lowercase addressable identifiers', () => {
    expect(principalId('alice')).toBe('alice')
    expect(principalId('user-1_2')).toBe('user-1_2')
    expect(principalId('a'.repeat(128))).toHaveLength(128)
  })

  it('rejects every spelling that could escape a per-user root or collide', () => {
    for (const invalid of ['', '.', '..', 'a/b', 'a.b', 'Alice', '-lead', 'a'.repeat(129), 'a b']) {
      expect(() => principalId(invalid)).toThrow(TypeError)
      expect(isPrincipalIdName(invalid)).toBe(false)
    }
  })
})

describe('PrincipalService binding', () => {
  it('reads no principal outside a run region', async () => {
    const ctx = await boot()
    expect(ctx.principal.current()).toBeUndefined()
  })

  it('binds a principal across awaits inside the region', async () => {
    const ctx = await boot()
    const seen = await ctx.principal.run(alice, async () => {
      await delay(1)
      return ctx.principal.current()
    })
    expect(seen).toBe(alice)
    expect(ctx.principal.current()).toBeUndefined()
  })

  it('keeps concurrent regions from seeing each other', async () => {
    const ctx = await boot()
    const read = (principal: typeof alice): Promise<string | undefined> =>
      ctx.principal.run(principal, async () => {
        await delay(principal === alice ? 5 : 1)
        return ctx.principal.current()?.id
      })
    expect(await Promise.all([read(alice), read(bob)])).toEqual(['alice', 'bob'])
  })

  it('lets the innermost binding win and restores the outer one', async () => {
    const ctx = await boot()
    ctx.principal.run(alice, () => {
      ctx.principal.run(bob, () => {
        expect(ctx.principal.current()).toBe(bob)
      })
      expect(ctx.principal.current()).toBe(alice)
    })
  })
})

describe('PrincipalService.require', () => {
  it('returns the bound principal', async () => {
    const ctx = await boot()
    expect(ctx.principal.run(alice, () => ctx.principal.require('test'))).toBe(alice)
  })

  it('names the consumer that needed one', async () => {
    const ctx = await boot()
    expect(() => ctx.principal.require('llm-litellm')).toThrow(PrincipalRequiredError)
    expect(() => ctx.principal.require('llm-litellm')).toThrow(/llm-litellm/)
  })
})

describe('PrincipalService.authenticate', () => {
  it('resolves a principal from either header representation', async () => {
    const ctx = await boot()
    expect(ctx.principal.authenticate({ headers: { 'x-test-principal': 'tok-alice' } })).toBe(alice)
    expect(ctx.principal.authenticate({ headers: new Headers({ 'x-test-principal': 'tok-bob' }) })).toBe(bob)
  })

  it('answers undefined for an absent or unknown identity', async () => {
    const ctx = await boot()
    expect(ctx.principal.authenticate({ headers: {} })).toBeUndefined()
    expect(ctx.principal.authenticate({ headers: { 'x-test-principal': 'tok-nobody' } })).toBeUndefined()
  })

  it('reports whether the deployment refuses anonymous requests', async () => {
    expect((await boot(false)).principal.required).toBe(false)
    expect((await boot(true)).principal.required).toBe(true)
  })
})
