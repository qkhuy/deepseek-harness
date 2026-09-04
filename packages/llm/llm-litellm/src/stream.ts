/**
 * Chat-completions stream deltas converted into harness {@link StreamChunk}
 * values.
 *
 * The conversion owns one piece of state the wire does not carry: harness
 * blocks are indexed and explicitly opened and closed, while the OpenAI stream
 * interleaves untagged text, reasoning, and tool-call deltas. {@link BlockWriter}
 * holds that mapping — which wire channel currently owns which block index —
 * so the adapter stays a transport.
 *
 * @module @deepseek-ai/dsh-llm-litellm/src/stream
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, FinishReason, StreamChunk, ToolCallId, TokenUsage } from '@deepseek-ai/dsh-llm'

/** The wire channel a delta belongs to; tool calls are keyed by their wire index. */
type Channel = 'text' | 'reasoning' | `tool:${number}`

/** One open block: its harness index and the content accumulated for its `block-end`. */
interface OpenBlock {
  readonly index: number
  readonly channel: Channel
  text: string
  toolCallId?: ToolCallId
  toolName?: string
}

/**
 * Assigns harness block indexes to wire channels and emits the
 * `block-start`/delta/`block-end` sequence the adapter contract requires.
 *
 * A channel that reappears after another channel interrupted it opens a NEW
 * block rather than reopening the closed one, because the harness protocol has
 * no reopen and the transcript must keep the order the model produced.
 */
export class BlockWriter {
  private next = 0
  private open: OpenBlock | undefined

  /**
   * Route one delta to its block, opening and closing blocks as the channel changes.
   * @param channel - the wire channel this delta belongs to.
   * @param text - the delta text; empty text still opens the block.
   * @param tool - call id and name, for a `tool:` channel's first delta.
   * @returns the chunks this delta produces, in emission order.
   */
  * write(channel: Channel, text: string, tool?: { id?: string; name?: string }): Generator<StreamChunk> {
    if (this.open !== undefined && this.open.channel !== channel) yield* this.close()
    if (this.open === undefined) {
      const blockType = channel === 'text' ? 'text' : channel === 'reasoning' ? 'reasoning' : 'tool-call'
      this.open = { index: this.next++, channel, text: '' }
      yield { type: 'block-start', index: this.open.index, blockType }
    }
    if (tool?.id !== undefined) this.open.toolCallId = brandString<ToolCallId>(tool.id)
    if (tool?.name !== undefined) this.open.toolName = tool.name
    this.open.text += text
    const { index } = this.open
    if (channel === 'text') yield { type: 'text-delta', index, text }
    else if (channel === 'reasoning') yield { type: 'reasoning-delta', index, text }
    else {
      yield {
        type: 'tool-call-delta',
        index,
        // A proxy that streams arguments before the id is a protocol error the
        // block-end assembly would surface as an unusable call; the empty
        // brand keeps the delta stream well-formed until the id arrives.
        id: this.open.toolCallId ?? brandString<ToolCallId>(''),
        ...tool?.name === undefined ? {} : { name: tool.name },
        argumentsDelta: text,
      }
    }
  }

  /**
   * Close the block currently open, if any.
   * @returns the `block-end` chunk, or nothing when no block is open.
   */
  * close(): Generator<StreamChunk> {
    const block = this.open
    if (block === undefined) return
    this.open = undefined
    yield { type: 'block-end', index: block.index, block: assembleBlock(block) }
  }
}

function assembleBlock(block: OpenBlock): ContentBlock {
  if (block.channel === 'text') return { type: 'text', text: block.text }
  if (block.channel === 'reasoning') return { type: 'reasoning', text: block.text }
  return {
    type: 'tool-call',
    id: block.toolCallId ?? brandString<ToolCallId>(''),
    name: block.toolName ?? '',
    arguments: block.text,
  }
}

/**
 * Map one wire `finish_reason` onto the harness vocabulary.
 *
 * `content_filter` becomes `stop` rather than an error: the upstream provider
 * completed the call and the response it produced is what the model turn is,
 * so treating it as a failure would retry a request that will be filtered
 * again.
 * @param reason - the proxy's `finish_reason`, absent while the stream continues.
 * @returns the harness finish reason, or `undefined` when the stream has not finished.
 */
export function finishReason(reason: string | null | undefined): FinishReason | undefined {
  switch (reason) {
    case 'stop':
    case 'content_filter':
      return { kind: 'stop' }
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      return undefined
  }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one `usage` object into harness token accounting.
 *
 * The harness counts are disjoint while OpenAI's `prompt_tokens` is an
 * aggregate that already includes cached input, so the cached share is
 * subtracted out here. LiteLLM forwards each upstream provider's cache
 * accounting under `prompt_tokens_details.cached_tokens`, which is the one
 * field this reads for it.
 * @param usage - the wire `usage` object.
 * @returns the harness usage, or `undefined` when the object carries no counts.
 */
export function tokenUsage(usage: unknown): TokenUsage | undefined {
  if (!isRecord(usage)) return undefined
  const prompt = count(usage.prompt_tokens)
  const output = count(usage.completion_tokens)
  if (prompt === undefined && output === undefined) return undefined
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {}
  const cacheRead = count(details.cached_tokens) ?? 0
  const reasoning = count(completionDetails.reasoning_tokens)
  const total = count(usage.total_tokens)
  return {
    inputTokens: Math.max((prompt ?? 0) - cacheRead, 0),
    outputTokens: output ?? 0,
    ...total === undefined ? {} : { totalTokens: total },
    ...cacheRead === 0 ? {} : { cacheReadTokens: cacheRead },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}
