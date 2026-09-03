import { describe, expect, it } from 'vitest'
import {
  LiteLlmClient,
  LiteLlmRequestError,
  liteLlmApiRoot,
  liteLlmChatCompletionsUrl,
  parseKeyIdentity,
  parseModelCatalog,
} from '../src/index.ts'
import { requestUrl } from './request-url.ts'

/** One scripted proxy: path → the response it answers, recording every request it saw. */
function proxy(routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>): {
  fetch: typeof globalThis.fetch
  calls: Array<{ url: string; authorization: string | null }>
} {
  const calls: Array<{ url: string; authorization: string | null }> = []
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const url = requestUrl(input)
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') })
    const path = new URL(url).pathname
    const route = routes[path]
    if (route === undefined) {
      return Promise.resolve(new Response('{"error":{"message":"no route"}}', { status: 404 }))
    }
    return Promise.resolve(new Response(
      typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {}),
      { status: route.status ?? 200, headers: route.headers },
    ))
  }
  return { fetch: fetchImpl, calls }
}

const client = (fetchImpl: typeof globalThis.fetch, baseURL = 'https://proxy.example/v1'): LiteLlmClient =>
  new LiteLlmClient({ baseURL, timeoutMs: 5000, fetch: fetchImpl })

describe('liteLlmApiRoot', () => {
  it('resolves both documented spellings to one API root', () => {
    expect(liteLlmApiRoot('https://proxy.example/v1')).toBe('https://proxy.example')
    expect(liteLlmApiRoot('https://proxy.example/v1/')).toBe('https://proxy.example')
    expect(liteLlmApiRoot('https://proxy.example/')).toBe('https://proxy.example')
    expect(liteLlmApiRoot('  https://proxy.example//  ')).toBe('https://proxy.example')
  })

  it('keeps a path prefix that is not the API version segment', () => {
    expect(liteLlmApiRoot('https://gw.example/litellm')).toBe('https://gw.example/litellm')
    expect(liteLlmApiRoot('https://gw.example/litellm/v1')).toBe('https://gw.example/litellm')
  })
})

describe('liteLlmChatCompletionsUrl', () => {
  it('builds one endpoint from either spelling', () => {
    expect(liteLlmChatCompletionsUrl('https://proxy.example')).toBe('https://proxy.example/v1/chat/completions')
    expect(liteLlmChatCompletionsUrl('https://proxy.example/v1/')).toBe('https://proxy.example/v1/chat/completions')
  })
})

describe('parseKeyIdentity', () => {
  it('reads the /key/info placement', () => {
    expect(parseKeyIdentity({
      key: 'sk-…',
      info: { user_id: 'u1', key_alias: 'laptop', team_id: 't1', models: ['gpt-4o'], max_budget: 25, spend: 1.5 },
    })).toEqual({
      userId: 'u1', keyAlias: 'laptop', teamId: 't1', models: ['gpt-4o'], maxBudget: 25, spend: 1.5,
    })
  })

  it('reads the /user/info and flat placements', () => {
    expect(parseKeyIdentity({ user_info: { user_id: 'u2', models: [] } })?.userId).toBe('u2')
    expect(parseKeyIdentity({ user_id: 'u3', models: [] })?.userId).toBe('u3')
  })

  it('falls back to the team id and then the alias for an addressable id', () => {
    expect(parseKeyIdentity({ info: { team_id: 't9', models: [] } })?.userId).toBe('t9')
    expect(parseKeyIdentity({ info: { key_alias: 'ci-runner', models: [] } })?.userId).toBe('ci-runner')
  })

  it('refuses a payload naming no addressable user', () => {
    expect(parseKeyIdentity({ info: { models: ['gpt-4o'] } })).toBeUndefined()
    expect(parseKeyIdentity({ info: { user_id: '   ' } })).toBeUndefined()
    expect(parseKeyIdentity('not-json-object')).toBeUndefined()
  })

  it('reads every wildcard spelling as unrestricted', () => {
    for (const wildcard of ['all-proxy-models', 'all-team-models', '*']) {
      expect(parseKeyIdentity({ info: { user_id: 'u', models: [wildcard, 'gpt-4o'] } })?.models).toEqual([])
    }
    expect(parseKeyIdentity({ info: { user_id: 'u' } })?.models).toEqual([])
  })

  it('drops limits the proxy sent as null or zero', () => {
    const identity = parseKeyIdentity({ info: { user_id: 'u', max_budget: null, spend: 0, expires: null } })
    expect(identity).toEqual({ userId: 'u', models: [], spend: 0 })
  })
})

describe('parseModelCatalog', () => {
  it('reads capacities and capability flags from /model/info', () => {
    expect(parseModelCatalog({
      data: [{
        model_name: 'gpt-4o',
        litellm_params: { custom_llm_provider: 'openai' },
        model_info: {
          display_name: 'GPT-4o', max_input_tokens: 128_000, max_output_tokens: 16_384,
          supports_vision: true, supports_reasoning: false,
        },
      }],
    })).toEqual([{
      id: 'gpt-4o', name: 'GPT-4o', provider: 'openai',
      contextWindow: 128_000, maxOutputTokens: 16_384, supportsVision: true, supportsReasoning: false,
    }])
  })

  it('reads the bare /v1/models listing', () => {
    expect(parseModelCatalog({ data: [{ id: 'claude-sonnet' }] })).toEqual([{ id: 'claude-sonnet', name: 'claude-sonnet' }])
  })

  it('falls back to max_tokens for the context window', () => {
    expect(parseModelCatalog({ data: [{ model_name: 'm', model_info: { max_tokens: 8192 } }] })[0]?.contextWindow)
      .toBe(8192)
  })

  it('keeps one entry per public alias across repeated deployments', () => {
    expect(parseModelCatalog({ data: [{ model_name: 'm' }, { model_name: 'm' }, { model_name: 'n' }] })
      .map(model => model.id)).toEqual(['m', 'n'])
  })

  it('answers empty for a body with no listing', () => {
    expect(parseModelCatalog({})).toEqual([])
    expect(parseModelCatalog({ data: 'nope' })).toEqual([])
    expect(parseModelCatalog({ data: [null, { }] })).toEqual([])
  })
})

describe('LiteLlmClient.verifyKey', () => {
  it('acts as the supplied key, never as an ambient one', async () => {
    const scripted = proxy({ '/key/info': { body: { info: { user_id: 'u1', models: [] } } } })
    await client(scripted.fetch).verifyKey('sk-user-key')
    expect(scripted.calls[0]?.authorization).toBe('Bearer sk-user-key')
    expect(scripted.calls[0]?.url).toBe('https://proxy.example/key/info')
  })

  it('falls back to /user/info when the proxy restricts /key/info', async () => {
    const scripted = proxy({
      '/key/info': { status: 401, body: { error: { message: 'admin only' } } },
      '/user/info': { body: { user_info: { user_id: 'u2', models: ['gpt-4o'] } } },
    })
    expect(await client(scripted.fetch).verifyKey('sk-x')).toEqual({ userId: 'u2', models: ['gpt-4o'] })
  })

  it('raises the /key/info verdict when both endpoints refuse the key', async () => {
    const scripted = proxy({
      '/key/info': { status: 401, body: { error: { message: 'Invalid proxy server token' } } },
      '/user/info': { status: 500, body: { error: { message: 'boom' } } },
    })
    await expect(client(scripted.fetch).verifyKey('sk-bad')).rejects.toMatchObject({
      failure: { code: 'AUTH', status: 401, message: 'Invalid proxy server token' },
    })
  })

  it('answers undefined when the proxy accepts the key but names no user', async () => {
    const scripted = proxy({ '/key/info': { body: { info: {} } }, '/user/info': { body: {} } })
    expect(await client(scripted.fetch).verifyKey('sk-x')).toBeUndefined()
  })

  it('reports an unreachable proxy as TRANSPORT rather than as a status', async () => {
    const unreachable: typeof globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'))
    await expect(client(unreachable).verifyKey('sk-x')).rejects.toMatchObject({
      failure: { code: 'TRANSPORT', status: 0 },
    })
  })

  it('classifies a non-JSON error page from its raw text', async () => {
    const scripted = proxy({
      '/key/info': { status: 502, body: '<html>bad gateway</html>' },
      '/user/info': { status: 502, body: '<html>bad gateway</html>' },
    })
    await expect(client(scripted.fetch).verifyKey('sk-x')).rejects.toBeInstanceOf(LiteLlmRequestError)
  })
})

describe('LiteLlmClient.listModels', () => {
  it('prefers the described /model/info catalog', async () => {
    const scripted = proxy({
      '/model/info': { body: { data: [{ model_name: 'gpt-4o', model_info: { max_input_tokens: 128_000 } }] } },
      '/v1/models': { body: { data: [{ id: 'gpt-4o' }] } },
    })
    expect(await client(scripted.fetch).listModels('sk-x')).toEqual([
      { id: 'gpt-4o', name: 'gpt-4o', contextWindow: 128_000 },
    ])
  })

  it('falls back to /v1/models when the proxy restricts /model/info', async () => {
    const scripted = proxy({
      '/model/info': { status: 401, body: {} },
      '/v1/models': { body: { data: [{ id: 'claude-sonnet' }] } },
    })
    expect(await client(scripted.fetch).listModels('sk-x')).toEqual([{ id: 'claude-sonnet', name: 'claude-sonnet' }])
  })

  it('answers an empty catalog rather than raising when the key may use nothing', async () => {
    const scripted = proxy({ '/model/info': { body: { data: [] } }, '/v1/models': { body: { data: [] } } })
    expect(await client(scripted.fetch).listModels('sk-x')).toEqual([])
  })

  it('raises when neither listing could be read', async () => {
    const scripted = proxy({ '/model/info': { status: 500, body: {} }, '/v1/models': { status: 500, body: {} } })
    await expect(client(scripted.fetch).listModels('sk-x')).rejects.toMatchObject({ failure: { code: 'SERVER' } })
  })
})

describe('LiteLlmClient endpoints', () => {
  it('exposes the API root and chat endpoint of either configured spelling', () => {
    const scripted = proxy({})
    expect(client(scripted.fetch, 'https://proxy.example/v1').apiRoot).toBe('https://proxy.example')
    expect(client(scripted.fetch, 'https://proxy.example').chatCompletionsUrl)
      .toBe('https://proxy.example/v1/chat/completions')
  })

  it('sends deployment headers with every management call', async () => {
    const seen: Array<Record<string, string>> = []
    const fetchImpl: typeof globalThis.fetch = (_input, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()))
      return Promise.resolve(new Response(JSON.stringify({ info: { user_id: 'u', models: [] } })))
    }
    await new LiteLlmClient({
      baseURL: 'https://proxy.example',
      timeoutMs: 5000,
      fetch: fetchImpl,
      headers: { 'x-deployment': 'blue' },
    }).verifyKey('sk-x')
    expect(seen[0]?.['x-deployment']).toBe('blue')
  })
})
