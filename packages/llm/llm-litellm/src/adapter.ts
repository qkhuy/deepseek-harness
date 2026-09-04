/**
 * The LiteLLM adapter: one chat-completions request per model call, streamed.
 *
 * Every request carries a key the adapter is *given per call* rather than one
 * it holds, which is the whole point of the package: in a signed-in
 * deployment, that key is the requesting user's own LiteLLM virtual key, so
 * the proxy applies that user's model access, rate limits, and budget, and
 * bills the spend to them.
 *
 * @module @deepseek-ai/dsh-llm-litellm/src/adapter
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import {
  LlmAdapter,
  LlmError,
  attributionHeaders,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { classifyLiteLlmFailure, liteLlmChatCompletionsUrl } from '@deepseek-ai/dsh-litellm-client'
import type { LiteLlmModel } from '@deepseek-ai/dsh-litellm-client'
import { serializeMessages, serializeTools } from './serialize.ts'
import { BlockWriter, finishReason, tokenUsage } from './stream.ts'

/** The connection facts one request resolves to, captured before its first await. */
export interface LiteLlmConnection {
  /** Proxy URL in either documented spelling. */
  readonly baseURL: string
  /** Request timeout in milliseconds. */
  readonly timeoutMs: number
  /** Deployment headers merged into every model request. */
  readonly headers: Readonly<Record<string, string>>
  /** Context capacity for a model the proxy does not size. */
  readonly defaultContextWindow: number
}

/** Everything the adapter needs from its mounting plugin, resolved per operation. */
export interface LiteLlmAdapterOptions {
  /** Current connection facts; re-read per operation so settings changes land without a restart. */
  readonly connection: () => LiteLlmConnection
  /** The key this exact request must act as; see the module contract for why it is per call. */
  readonly resolveApiKey: () => Promise<string>
  /** The models the requesting identity may use, for the advisory catalog. */
  readonly listCatalog: () => Promise<readonly LiteLlmModel[]>
  /** Route-owned retry policy the seam captures at registration. */
  readonly retryPolicy?: ResolvedRetryPolicy
  /** Fetch implementation; defaults to the global. */
  readonly fetch?: typeof globalThis.fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Turn a classified proxy failure into the seam's error type without losing its facts. */
function llmError(status: number, body: unknown, retryAfter?: string): LlmError {
  const failure = classifyLiteLlmFailure(status, body, retryAfter)
  return new LlmError(`llm-litellm: ${failure.message}`, failure.code, {
    status: failure.status,
    ...failure.retryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.retryAfterMs },
  })
}

/** One streamed `choices[0].delta`, as the proxy sends it. */
interface WireDelta {
  readonly content?: string | null
  readonly reasoning_content?: string | null
  readonly tool_calls?: readonly {
    readonly index?: number
    readonly id?: string
    readonly function?: { readonly name?: string; readonly arguments?: string }
  }[]
}

/** The LiteLLM chat-completions adapter for one registered provider route. */
export class LiteLlmAdapter extends LlmAdapter {
  /**
   * @param options - per-operation connection, credential, and catalog resolution.
   */
  constructor(private readonly options: LiteLlmAdapterOptions) {
    super()
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.options.retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.options.listCatalog()
    return models.map((model): LlmModelInfo => ({
      provider,
      id: model.id,
      name: model.name,
      ...model.provider === undefined ? {} : { description: `via ${model.provider}` },
      inputModalities: model.supportsVision === true ? ['text', 'image'] : ['text'],
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const connection = this.options.connection()
    // A catalog read that fails must not stop a request for a model the caller
    // already named: the proxy is the authority on whether it serves the model,
    // and it answers that when the request arrives.
    const described = await this.options.listCatalog().then(
      models => models.find(entry => entry.id === model),
      () => undefined,
    )
    return {
      provider,
      id: model,
      name: described?.name ?? model,
      context: { contextWindow: described?.contextWindow ?? connection.defaultContextWindow },
      ...described?.maxOutputTokens === undefined ? {} : { defaultMaxTokens: described.maxOutputTokens },
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The whole snapshot is captured before the first await, so a settings
    // change mid-request cannot combine one generation's endpoint with
    // another's credential.
    const connection = this.options.connection()
    const key = await this.options.resolveApiKey()
    const fetchImpl = this.options.fetch ?? globalThis.fetch

    const body = {
      model: options.model,
      messages: serializeMessages(options.messages, options.system),
      stream: true,
      // LiteLLM only forwards usage on the final chunk when the caller asks
      // for it; without this the harness would record every call as zero-cost.
      stream_options: { include_usage: true },
      ...serializeTools(options.tools) === undefined ? {} : { tools: serializeTools(options.tools) },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
      ...options.stop === undefined || options.stop.length === 0 ? {} : { stop: options.stop },
    }

    const timeout = AbortSignal.timeout(connection.timeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])

    let response: Response
    try {
      response = await fetchImpl(liteLlmChatCompletionsUrl(connection.baseURL), {
        method: 'POST',
        headers: {
          ...connection.headers,
          ...attributionHeaders(),
          'authorization': `Bearer ${key}`,
          'content-type': 'application/json',
          'accept': 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
        return
      }
      throw new LlmError(
        `llm-litellm: the LiteLLM proxy at ${connection.baseURL} could not be reached`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let errorBody: unknown = await response.text()
      try {
        errorBody = JSON.parse(errorBody as string)
      } catch {
        // A non-JSON error body is a proxy error page; its raw text is what
        // the classifier reads.
      }
      throw llmError(response.status, errorBody, response.headers.get('retry-after') ?? undefined)
    }
    if (response.body === null) {
      throw new LlmError('llm-litellm: the proxy answered a streaming request with no body', 'STREAM_CLOSED')
    }

    yield* this.readStream(response.body, options)
  }

  /** Decode the SSE response into chunks; separated so `stream` reads as one request. */
  private async * readStream(
    body: ReadableStream<BufferSource>,
    options: GenerateOptions,
  ): AsyncGenerator<StreamChunk> {
    const writer = new BlockWriter()
    let finish: ReturnType<typeof finishReason>
    let sawTerminator = false
    const events = body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())

    try {
      for await (const event of events) {
        if (event.data === '[DONE]') {
          sawTerminator = true
          break
        }
        let payload: unknown
        try {
          payload = JSON.parse(event.data)
        } catch {
          throw new LlmError('llm-litellm: the proxy sent a stream event that is not JSON', 'PROTOCOL')
        }
        if (!isRecord(payload)) continue
        // An in-stream error object is how LiteLLM reports an upstream failure
        // that only appeared after headers were sent.
        if (isRecord(payload.error)) {
          throw llmError(typeof payload.error.code === 'number' ? payload.error.code : 500, payload)
        }
        const usage = tokenUsage(payload.usage)
        const choices: readonly unknown[] = Array.isArray(payload.choices) ? payload.choices : []
        const choice: unknown = choices[0]
        if (isRecord(choice)) {
          yield* this.writeDelta(writer, choice.delta as WireDelta | undefined)
          finish = finishReason(choice.finish_reason as string | null | undefined) ?? finish
        }
        // Usage rides the final chunk, whose `choices` is empty; emitting it
        // after the deltas keeps the adapter's "usage before finish" contract.
        if (usage !== undefined) {
          yield* writer.close()
          yield { type: 'usage', usage }
        }
      }
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield* writer.close()
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
        return
      }
      throw error
    }

    yield* writer.close()
    if (!sawTerminator) {
      throw new LlmError('llm-litellm: the proxy stream ended without [DONE]', 'STREAM_CLOSED')
    }
    // A stream that ended cleanly but named no reason completed: the proxy
    // omits `finish_reason` on some upstream routes, and refusing the turn
    // would discard a response the model already produced.
    yield { type: 'finish', reason: finish ?? { kind: 'stop' } }
  }

  /** Route one wire delta's channels through the block writer. */
  private * writeDelta(writer: BlockWriter, delta: WireDelta | undefined): Generator<StreamChunk> {
    if (delta === undefined) return
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      yield* writer.write('reasoning', delta.reasoning_content)
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      yield* writer.write('text', delta.content)
    }
    for (const call of delta.tool_calls ?? []) {
      yield* writer.write(
        `tool:${call.index ?? 0}`,
        call.function?.arguments ?? '',
        {
          ...call.id === undefined ? {} : { id: call.id },
          ...call.function?.name === undefined ? {} : { name: call.function.name },
        },
      )
    }
  }
}
