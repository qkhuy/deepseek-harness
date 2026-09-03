/**
 * The adapter as the proxy sees it: which key is on the wire, what the request
 * body says, and what the SSE response becomes.
 */

import { describe, expect, it } from 'vitest'
import { createMessage, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LiteLlmAdapter } from '../src/index.ts'
import type { LiteLlmConnection } from '../src/index.ts'
import { requestUrl } from '../../../litellm/litellm-client/tests/request-url.ts'

const connection: LiteLlmConnection = {
  baseURL: 'https://proxy.example/v1',
  timeoutMs: 5000,
  headers: {},
  defaultContextWindow: 128_000,
}

const messages: Message[] = [createMessage({
  role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
})]

const request = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: 'litellm', model: 'gpt-4o', messages, ...overrides,
})

/** A proxy answering one scripted SSE body, recording what each request carried. */
function proxy(events: string[], status = 200, errorHeaders?: Record<string, string>): {
  fetch: typeof globalThis.fetch
  calls: Array<{ authorization: string | null; body: Record<string, unknown>; url: string }>
} {
  const calls: Array<{ authorization: string | null; body: Record<string, unknown>; url: string }> = []
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    calls.push({
      url: requestUrl(input),
      authorization: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    })
    if (status !== 200) {
      return Promise.resolve(new Response(
        JSON.stringify({ error: { message: 'refused' } }),
        { status, ...errorHeaders === undefined ? {} : { headers: errorHeaders } },
      ))
    }
    return Promise.resolve(new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${event}\n\n`))
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
  }
  return { fetch: fetchImpl, calls }
}

/** A proxy answering `200 OK` with a null body, an upstream misbehavior. */
function proxyWithNoBody(): typeof globalThis.fetch {
  return () => Promise.resolve(new Response(null, { status: 200 }))
}

const collect = async (stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const adapter = (
  scripted: ReturnType<typeof proxy>,
  key = 'sk-caller',
): LiteLlmAdapter => new LiteLlmAdapter({
  connection: () => connection,
  resolveApiKey: () => Promise.resolve(key),
  listCatalog: () => Promise.resolve([]),
  fetch: scripted.fetch,
})

const textStream = [
  JSON.stringify({ choices: [{ delta: { content: 'he' } }] }),
  JSON.stringify({ choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] }),
  JSON.stringify({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }),
  '[DONE]',
]

describe('the key on the wire', () => {
  it('is the one this exact call resolved, never a stored one', async () => {
    const scripted = proxy(textStream)
    await collect(adapter(scripted, 'sk-alice').stream(request()))
    expect(scripted.calls[0]?.authorization).toBe('Bearer sk-alice')
  })

  it('changes with the caller, request by request, on one adapter instance', async () => {
    const scripted = proxy(textStream)
    const keys = ['sk-alice', 'sk-bob']
    let at = 0
    const shared = new LiteLlmAdapter({
      connection: () => connection,
      resolveApiKey: () => Promise.resolve(keys[at++]!),
      listCatalog: () => Promise.resolve([]),
      fetch: scripted.fetch,
    })
    await collect(shared.stream(request()))
    await collect(shared.stream(request()))
    expect(scripted.calls.map(call => call.authorization)).toEqual(['Bearer sk-alice', 'Bearer sk-bob'])
  })

  it('reaches the chat-completions endpoint of the configured proxy', async () => {
    const scripted = proxy(textStream)
    await collect(adapter(scripted).stream(request()))
    expect(scripted.calls[0]?.url).toBe('https://proxy.example/v1/chat/completions')
  })

  it('uses the global fetch when no override is given', async () => {
    const realFetch = globalThis.fetch
    let called = false
    globalThis.fetch = (..._args: Parameters<typeof fetch>) => {
      called = true
      return Promise.resolve(new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ))
    }
    try {
      const bare = new LiteLlmAdapter({
        connection: () => connection,
        resolveApiKey: () => Promise.resolve('sk-x'),
        listCatalog: () => Promise.resolve([]),
      })
      await collect(bare.stream(request()))
      expect(called).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('the request body', () => {
  it('asks for usage, which the proxy withholds otherwise', async () => {
    const scripted = proxy(textStream)
    await collect(adapter(scripted).stream(request()))
    expect(scripted.calls[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } })
  })

  it('carries the sampling fields the request set and omits the rest', async () => {
    const scripted = proxy(textStream)
    await collect(adapter(scripted).stream(request({ temperature: 0.2, maxTokens: 100, stop: ['END'] })))
    expect(scripted.calls[0]?.body).toMatchObject({ temperature: 0.2, max_tokens: 100, stop: ['END'] })
    const bare = proxy(textStream)
    await collect(adapter(bare).stream(request()))
    expect(Object.keys(bare.calls[0]?.body ?? {})).not.toContain('temperature')
    expect(Object.keys(bare.calls[0]?.body ?? {})).not.toContain('stop')
  })

  it('omits stop when the request declares an empty list', async () => {
    const scripted = proxy(textStream)
    await collect(adapter(scripted).stream(request({ stop: [] })))
    expect(Object.keys(scripted.calls[0]?.body ?? {})).not.toContain('stop')
  })

  it('projects offered tool schemas onto the OpenAI function form', async () => {
    const scripted = proxy(textStream)
    await collect(adapter(scripted).stream(request({
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    })))
    expect(scripted.calls[0]?.body.tools).toEqual([
      { type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object' } } },
    ])
  })
})

describe('the streamed response', () => {
  it('becomes text blocks, usage, and a finish', async () => {
    const chunks = await collect(adapter(proxy(textStream)).stream(request()))
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish',
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('separates reasoning from visible text', async () => {
    const chunks = await collect(adapter(proxy([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'why' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'because' }, finish_reason: 'stop' }] }),
      '[DONE]',
    ])).stream(request()))
    expect(chunks.filter(chunk => chunk.type === 'reasoning-delta')).toHaveLength(1)
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toHaveLength(1)
  })

  it('assembles a tool call streamed across chunks', async () => {
    const chunks = await collect(adapter(proxy([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"p' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":1}' } }] }, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ])).stream(request()))
    expect(chunks.find(chunk => chunk.type === 'block-end')).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"p":1}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('completes a stream the proxy ended without naming a reason', async () => {
    const chunks = await collect(adapter(proxy([
      JSON.stringify({ choices: [{ delta: { content: 'a' } }] }),
      '[DONE]',
    ])).stream(request()))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('refuses a truncated stream rather than reporting a complete turn', async () => {
    await expect(collect(adapter(proxy([
      JSON.stringify({ choices: [{ delta: { content: 'a' } }] }),
    ])).stream(request()))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('reports an in-stream proxy error instead of a silent short answer', async () => {
    await expect(collect(adapter(proxy([
      JSON.stringify({ error: { message: 'upstream exploded', code: 503 } }),
      '[DONE]',
    ])).stream(request()))).rejects.toMatchObject({ code: 'SERVER' })
  })

  it('refuses a stream event that is not JSON', async () => {
    await expect(collect(adapter(proxy(['{oops'])).stream(request())))
      .rejects.toMatchObject({ code: 'PROTOCOL' })
  })

  it('refuses a streaming response the proxy answered with no body', async () => {
    await expect(collect(adapter({ fetch: proxyWithNoBody(), calls: [] }).stream(request())))
      .rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('skips a stream event whose JSON is not an object', async () => {
    const chunks = await collect(adapter(proxy([
      '42',
      JSON.stringify({ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] }),
      '[DONE]',
    ])).stream(request()))
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'a' }])
  })

  it('classifies an in-stream error with no numeric code as a server failure', async () => {
    await expect(collect(adapter(proxy([
      JSON.stringify({ error: { message: 'upstream exploded' } }),
      '[DONE]',
    ])).stream(request()))).rejects.toMatchObject({ code: 'SERVER' })
  })

  it('tolerates a final chunk reporting usage with no choices field at all', async () => {
    const chunks = await collect(adapter(proxy([
      JSON.stringify({ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] }),
      JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      '[DONE]',
    ])).stream(request()))
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({ type: 'usage' })
  })

  it('ignores a choice entry with no delta field', async () => {
    const chunks = await collect(adapter(proxy([
      JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
      '[DONE]',
    ])).stream(request()))
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('defaults a tool-call delta with no wire index or arguments', async () => {
    const chunks = await collect(adapter(proxy([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'read' } }] }, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ])).stream(request()))
    expect(chunks.find(chunk => chunk.type === 'block-end')).toEqual({
      type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '' },
    })
  })

  it('ends an in-stream failure as aborted when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    const fetchImpl: typeof globalThis.fetch = () => {
      controller.abort()
      return Promise.resolve(new Response(
        new ReadableStream<Uint8Array>({
          start(sseController) {
            sseController.enqueue(new TextEncoder().encode('data: {oops\n\n'))
            sseController.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ))
    }
    const chunks = await collect(adapter({ fetch: fetchImpl, calls: [] })
      .stream(request({ signal: controller.signal })))
    expect(chunks).toEqual([{
      type: 'finish',
      reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } },
    }])
  })
})

describe('proxy refusals', () => {
  it('classifies a rejected key as AUTH with its status', async () => {
    await expect(collect(adapter(proxy([], 401)).stream(request())))
      .rejects.toMatchObject({ code: 'AUTH', failure: { status: 401 } })
  })

  it('classifies an exhausted allowance as RATE_LIMIT', async () => {
    await expect(collect(adapter(proxy([], 429)).stream(request())))
      .rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('carries the proxy-requested retry delay', async () => {
    await expect(collect(adapter(proxy([], 429, { 'retry-after': '2' })).stream(request())))
      .rejects.toMatchObject({ code: 'RATE_LIMIT', failure: { providerRetryAfterMs: 2000 } })
  })

  it('reports an unreachable proxy as TRANSPORT', async () => {
    const unreachable = {
      fetch: (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof globalThis.fetch,
      calls: [],
    }
    await expect(collect(adapter(unreachable).stream(request())))
      .rejects.toBeInstanceOf(LlmError)
    await expect(collect(adapter(unreachable).stream(request())))
      .rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('ends an aborted request as aborted rather than as a failure', async () => {
    const controller = new AbortController()
    const aborting = {
      fetch: (() => {
        controller.abort()
        return Promise.reject(new Error('aborted'))
      }) as typeof globalThis.fetch,
      calls: [],
    }
    const chunks = await collect(adapter(aborting).stream(request({ signal: controller.signal })))
    expect(chunks).toEqual([{
      type: 'finish',
      reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } },
    }])
  })
})

describe('providerRetryPolicy', () => {
  it('returns the resolved policy the adapter was constructed with', () => {
    const policy = resolveRetryPolicy({ mode: 'normal', maxRetries: 3 }, 'test')
    const withPolicy = new LiteLlmAdapter({
      connection: () => connection,
      resolveApiKey: () => Promise.resolve('sk-x'),
      listCatalog: () => Promise.resolve([]),
      retryPolicy: policy,
    })
    expect(withPolicy.providerRetryPolicy('litellm')).toBe(policy)
  })

  it('answers undefined when none was configured', () => {
    const withoutPolicy = new LiteLlmAdapter({
      connection: () => connection,
      resolveApiKey: () => Promise.resolve('sk-x'),
      listCatalog: () => Promise.resolve([]),
    })
    expect(withoutPolicy.providerRetryPolicy('litellm')).toBeUndefined()
  })
})

describe('model metadata', () => {
  it('advertises the catalog the requesting identity may use', async () => {
    const withCatalog = new LiteLlmAdapter({
      connection: () => connection,
      resolveApiKey: () => Promise.resolve('sk-x'),
      listCatalog: () => Promise.resolve([
        { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', supportsVision: true },
        { id: 'text-only', name: 'Text Only' },
      ]),
      fetch: proxy([]).fetch,
    })
    expect(await withCatalog.listModels('litellm')).toEqual([
      { provider: 'litellm', id: 'gpt-4o', name: 'GPT-4o', description: 'via openai', inputModalities: ['text', 'image'] },
      { provider: 'litellm', id: 'text-only', name: 'Text Only', inputModalities: ['text'] },
    ])
  })

  it('sizes a described model from the proxy and an undescribed one from the fallback', async () => {
    const withCatalog = new LiteLlmAdapter({
      connection: () => connection,
      resolveApiKey: () => Promise.resolve('sk-x'),
      listCatalog: () => Promise.resolve([{ id: 'gpt-4o', name: 'GPT-4o', contextWindow: 200_000, maxOutputTokens: 8192 }]),
      fetch: proxy([]).fetch,
    })
    expect(await withCatalog.resolveModel('litellm', 'gpt-4o')).toEqual({
      provider: 'litellm', id: 'gpt-4o', name: 'GPT-4o',
      context: { contextWindow: 200_000 }, defaultMaxTokens: 8192,
    })
    expect((await withCatalog.resolveModel('litellm', 'unlisted')).context).toEqual({ contextWindow: 128_000 })
  })

  it('still serves a named model when the catalog read fails', async () => {
    const failing = new LiteLlmAdapter({
      connection: () => connection,
      resolveApiKey: () => Promise.resolve('sk-x'),
      listCatalog: () => Promise.reject(new Error('proxy down')),
      fetch: proxy([]).fetch,
    })
    expect(await failing.resolveModel('litellm', 'gpt-4o')).toMatchObject({ id: 'gpt-4o', name: 'gpt-4o' })
  })
})
