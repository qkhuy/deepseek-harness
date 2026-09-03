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
import * as LlmLiteLlm from '../src/index.ts'
import { requestUrl } from '../../../litellm/litellm-client/tests/request-url.ts'

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
afterEach(() => {
  globalThis.fetch = realFetch
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
