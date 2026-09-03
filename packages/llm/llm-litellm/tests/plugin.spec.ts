/**
 * The mounted route's credential rule: a signed-in user's key outranks the
 * configured reference, and each user sees only the catalog their key allows.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { PrincipalService, principalId } from '@deepseek-ai/dsh-principal'
import type { Principal, PrincipalRequest } from '@deepseek-ai/dsh-principal'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo,
  CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import * as LlmLiteLlm from '../src/index.ts'
import { requestUrl } from '../../../litellm/litellm-client/tests/request-url.ts'
import { LiteLlmClient } from '@deepseek-ai/dsh-litellm-client'

/** The environment credential a deployment configures for unattended work. */
class FixedCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly value?: string) {
    super(ctx)
  }

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(this.value === undefined ? undefined : { value: this.value, source: 'test' })
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.value !== undefined, writable: false })
  }

  override set(): Promise<void> { return Promise.resolve() }
  override unset(): Promise<void> { return Promise.resolve() }
  override readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined) }
  override describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: false })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> { return Promise.resolve([]) }
  override modifyRecord(): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined) }
  override deleteRecord(): Promise<void> { return Promise.resolve() }
}

/** A credential source that fails for a reason no reference could fix — never MISSING_CREDENTIAL. */
class ThrowingCredentials extends CredentialProvider {
  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.reject(new Error('credential store unavailable'))
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: false })
  }

  override set(): Promise<void> { return Promise.resolve() }
  override unset(): Promise<void> { return Promise.resolve() }
  override readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined) }
  override describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: false })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> { return Promise.resolve([]) }
  override modifyRecord(): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined) }
  override deleteRecord(): Promise<void> { return Promise.resolve() }
}

/** A principal seam whose binding the test drives directly. */
class TestPrincipals extends PrincipalService {
  override get required(): boolean { return true }
  override authenticate(_request: PrincipalRequest): Principal | undefined { return undefined }
}

const alice: Principal = {
  id: principalId('alice'), displayName: 'Alice', secret: 'sk-alice', models: ['gpt-4o'],
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/**
 * Boot the route over a scripted proxy and report the distinct keys the proxy
 * was shown. Distinct, because one catalog read legitimately asks two
 * endpoints with the same key.
 */
async function boot(options: {
  envKey?: string
  withPrincipal?: boolean
  catalog?: Record<string, string[]>
}): Promise<{ ctx: Context; keys: string[] }> {
  const keys: string[] = []
  const catalog = options.catalog ?? {}
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const key = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? ''
    keys.push(key)
    const url = new URL(requestUrl(input))
    if (url.pathname === '/model/info') {
      const models = catalog[key] ?? []
      return Promise.resolve(new Response(JSON.stringify({ data: models.map(id => ({ model_name: id })) })))
    }
    return Promise.resolve(new Response('{"data":[]}'))
  }
  globalThis.fetch = fetchImpl
  context = new Context()
  await context.plugin(LlmRuntime)
  await context.plugin(FixedCredentials, options.envKey)
  if (options.withPrincipal === true) await context.plugin(TestPrincipals)
  await context.plugin(LlmLiteLlm, { baseURL: 'https://proxy.example', catalogTtlSeconds: 0 })
  return { ctx: context, keys }
}

/** Every key the proxy was shown, de-duplicated in first-seen order. */
const distinct = (keys: readonly string[]): string[] => [...new Set(keys)]

const realFetch = globalThis.fetch
const createClient = LlmLiteLlm.internals.createClient
afterEach(() => {
  globalThis.fetch = realFetch
  LlmLiteLlm.internals.createClient = createClient
})

describe('which key a request acts as', () => {
  it('uses the signed-in user key, not the configured reference', async () => {
    const { ctx, keys } = await boot({ envKey: 'sk-from-env', withPrincipal: true })
    await ctx.principal.run(alice, async () => {
      await ctx.llm.listModels('litellm')
    })
    expect(distinct(keys)).toEqual(['sk-alice'])
    expect(keys).not.toContain('sk-from-env')
  })

  it('falls back to the configured reference for work no user made', async () => {
    const { ctx, keys } = await boot({ envKey: 'sk-from-env', withPrincipal: true })
    await ctx.llm.listModels('litellm')
    expect(distinct(keys)).toEqual(['sk-from-env'])
  })

  it('uses the configured reference where no principal seam is mounted at all', async () => {
    const { ctx, keys } = await boot({ envKey: 'sk-from-env' })
    await ctx.llm.listModels('litellm')
    expect(distinct(keys)).toEqual(['sk-from-env'])
  })

  it('refuses a request with neither a signed-in user nor a configured reference', async () => {
    const { ctx } = await boot({ withPrincipal: true })
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'litellm', model: 'gpt-4o', messages: [] })) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'error', failure: expect.objectContaining({ code: 'MISSING_CREDENTIAL' }) as unknown } },
    ])
  })

  it('offers an empty catalog rather than failing before anyone has signed in', async () => {
    const { ctx, keys } = await boot({ withPrincipal: true })
    expect(await ctx.llm.listModels('litellm')).toEqual([])
    expect(keys).toEqual([])
  })
})

describe('which models a user is offered', () => {
  it('answers each user from their own key, never from another user cached catalog', async () => {
    const bob: Principal = { id: principalId('bob'), displayName: 'Bob', secret: 'sk-bob', models: [] }
    const { ctx } = await boot({
      withPrincipal: true,
      catalog: { 'sk-alice': ['gpt-4o'], 'sk-bob': ['claude-sonnet'] },
    })
    const forAlice = await ctx.principal.run(alice, async () => await ctx.llm.listModels('litellm'))
    const forBob = await ctx.principal.run(bob, async () => await ctx.llm.listModels('litellm'))
    expect(forAlice.map(model => model.id)).toEqual(['gpt-4o'])
    expect(forBob.map(model => model.id)).toEqual(['claude-sonnet'])
  })
})

describe('resolveBaseUrl', () => {
  it('falls back to $LITELLM_BASE_URL when the config omits baseURL', () => {
    const environment = createLaunchEnvironmentSnapshot([
      { source: 'process', values: { LITELLM_BASE_URL: 'https://env.example' } },
    ])
    expect(LlmLiteLlm.resolveBaseUrl({ apiKeyEnv: 'X' }, environment)).toBe('https://env.example')
  })

  it('prefers an explicitly configured baseURL over the environment', () => {
    const environment = createLaunchEnvironmentSnapshot([
      { source: 'process', values: { LITELLM_BASE_URL: 'https://env.example' } },
    ])
    expect(LlmLiteLlm.resolveBaseUrl({ baseURL: 'https://configured.example', apiKeyEnv: 'X' }, environment))
      .toBe('https://configured.example')
  })

  it('throws INVALID_CONFIG with neither a configured baseURL nor the environment variable', () => {
    const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }])
    expect(() => LlmLiteLlm.resolveBaseUrl({ apiKeyEnv: 'X' }, environment)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    )
    expect(() => LlmLiteLlm.resolveBaseUrl({ apiKeyEnv: 'X' })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    )
  })
})

describe('endpoint resolution at mount', () => {
  it('boots against the environment-resolved endpoint end to end', async () => {
    const seen: string[] = []
    globalThis.fetch = (input) => {
      seen.push(new URL(requestUrl(input)).origin)
      return Promise.resolve(new Response('{"data":[]}'))
    }
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(FixedCredentials, 'sk-x')
    context.provide('launchEnvironment', createLaunchEnvironmentSnapshot([
      { source: 'process', values: { LITELLM_BASE_URL: 'https://env.example' } },
    ]))
    await context.plugin(LlmLiteLlm, {})
    await context.llm.listModels('litellm')
    expect(distinct(seen)).toEqual(['https://env.example'])
  })
})

describe('the per-principal catalog cache', () => {
  it('reuses a cached catalog within the TTL instead of asking the proxy again', async () => {
    let calls = 0
    globalThis.fetch = (input) => {
      calls += 1
      const url = new URL(requestUrl(input))
      if (url.pathname === '/model/info') return Promise.resolve(new Response('{"data":[{"model_name":"gpt-4o"}]}'))
      return Promise.resolve(new Response('{"data":[]}'))
    }
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(FixedCredentials, 'sk-x')
    await context.plugin(LlmLiteLlm, { baseURL: 'https://proxy.example', catalogTtlSeconds: 300 })
    const first = await context.llm.listModels('litellm')
    const modelInfoCalls = calls
    const second = await context.llm.listModels('litellm')
    expect(second).toEqual(first)
    expect(calls).toBe(modelInfoCalls)
  })

  it('does not cache a failed read, so the next call retries', async () => {
    let modelInfoCalls = 0
    globalThis.fetch = (input) => {
      const url = new URL(requestUrl(input))
      if (url.pathname === '/model/info') {
        modelInfoCalls += 1
        return Promise.resolve(new Response('{"error":{"message":"down"}}', { status: 500 }))
      }
      return Promise.resolve(new Response('{"error":{"message":"down"}}', { status: 500 }))
    }
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(FixedCredentials, 'sk-x')
    await context.plugin(LlmLiteLlm, { baseURL: 'https://proxy.example', catalogTtlSeconds: 300 })
    expect(await context.llm.listModels('litellm')).toEqual([])
    expect(await context.llm.listModels('litellm')).toEqual([])
    expect(modelInfoCalls).toBe(2)
  })
})

describe('unrecoverable catalog failures propagate', () => {
  it('rethrows a credential-resolution failure that is not MISSING_CREDENTIAL', async () => {
    globalThis.fetch = () => Promise.resolve(new Response('{"data":[]}'))
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(ThrowingCredentials)
    await context.plugin(LlmLiteLlm, { baseURL: 'https://proxy.example' })
    await expect(context.llm.listModels('litellm')).rejects.toThrow('credential store unavailable')
  })

  it('rethrows a proxy client failure that is not a classified LiteLlmRequestError', async () => {
    LlmLiteLlm.internals.createClient = () => ({
      listModels: () => Promise.reject(new Error('client exploded')),
    }) as unknown as LiteLlmClient
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(FixedCredentials, 'sk-x')
    await context.plugin(LlmLiteLlm, { baseURL: 'https://proxy.example' })
    await expect(context.llm.listModels('litellm')).rejects.toThrow('client exploded')
  })
})

describe('registration', () => {
  it('publishes the route and its configurable-provider entry', async () => {
    const { ctx } = await boot({ envKey: 'sk-x' })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('litellm')
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toContain('litellm')
  })

  it('withdraws the route when the plugin unmounts', async () => {
    globalThis.fetch = () => Promise.resolve(new Response('{"data":[]}'))
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(FixedCredentials, 'sk-x')
    const route = context.plugin(LlmLiteLlm, { baseURL: 'https://proxy.example' })
    await route.await()
    expect(context.llm.listProviders().map(provider => provider.id)).toContain('litellm')
    await route.dispose()
    expect(context.llm.listProviders().map(provider => provider.id)).not.toContain('litellm')
  })
})
