import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { BlockWriter, finishReason, tokenUsage } from '../src/index.ts'

const drain = (chunks: Iterable<StreamChunk>): StreamChunk[] => [...chunks]

describe('BlockWriter', () => {
  it('opens, streams, and closes one text block', () => {
    const writer = new BlockWriter()
    const chunks = [...drain(writer.write('text', 'he')), ...drain(writer.write('text', 'llo')), ...drain(writer.close())]
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'he' },
      { type: 'text-delta', index: 0, text: 'llo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    ])
  })

  it('closes the open block when the channel changes', () => {
    const writer = new BlockWriter()
    const chunks = [...drain(writer.write('reasoning', 'why')), ...drain(writer.write('text', 'because'))]
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'reasoning-delta', 'block-end', 'block-start', 'text-delta',
    ])
    expect(chunks[2]).toEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'why' } })
  })

  it('opens a new block when a channel reappears, keeping the produced order', () => {
    const writer = new BlockWriter()
    drain(writer.write('text', 'a'))
    drain(writer.write('reasoning', 'b'))
    const reopened = drain(writer.write('text', 'c'))
    expect(reopened[0]).toEqual({ type: 'block-end', index: 1, block: { type: 'reasoning', text: 'b' } })
    expect(reopened[1]).toEqual({ type: 'block-start', index: 2, blockType: 'text' })
  })

  it('assembles a tool call from its id, name, and streamed arguments', () => {
    const writer = new BlockWriter()
    drain(writer.write('tool:0', '{"pa', { id: 'call_1', name: 'read' }))
    drain(writer.write('tool:0', 'th":"a"}'))
    expect(drain(writer.close())[0]).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
    })
  })

  it('gives each wire tool-call index its own block', () => {
    const writer = new BlockWriter()
    drain(writer.write('tool:0', '{}', { id: 'call_1', name: 'a' }))
    const second = drain(writer.write('tool:1', '{}', { id: 'call_2', name: 'b' }))
    expect(second.map(chunk => chunk.type)).toEqual(['block-end', 'block-start', 'tool-call-delta'])
  })

  it('carries the tool name on the delta that supplied it', () => {
    const writer = new BlockWriter()
    const chunks = drain(writer.write('tool:0', '', { id: 'call_1', name: 'read' }))
    expect(chunks[1]).toMatchObject({ type: 'tool-call-delta', id: 'call_1', name: 'read' })
  })

  it('closes nothing when no block is open', () => {
    const writer = new BlockWriter()
    expect(drain(writer.close())).toEqual([])
    drain(writer.write('text', 'a'))
    drain(writer.close())
    expect(drain(writer.close())).toEqual([])
  })

  it('keeps the delta stream well-formed when arguments arrive before an id', () => {
    const writer = new BlockWriter()
    const delta = drain(writer.write('tool:0', '{}'))
    expect(delta[1]).toMatchObject({ type: 'tool-call-delta', id: '' })
    expect(drain(writer.close())[0]).toMatchObject({ block: { id: '', name: '' } })
  })
})

describe('finishReason', () => {
  it('maps the reasons the wire names', () => {
    expect(finishReason('stop')).toEqual({ kind: 'stop' })
    expect(finishReason('tool_calls')).toEqual({ kind: 'tool-calls' })
    expect(finishReason('function_call')).toEqual({ kind: 'tool-calls' })
    expect(finishReason('length')).toEqual({ kind: 'max-tokens' })
  })

  it('treats a filtered completion as a completion, not a failure', () => {
    expect(finishReason('content_filter')).toEqual({ kind: 'stop' })
  })

  it('names no reason while the stream continues or the proxy sent one it does not know', () => {
    expect(finishReason(null)).toBeUndefined()
    expect(finishReason(undefined)).toBeUndefined()
    expect(finishReason('something_new')).toBeUndefined()
  })
})

describe('tokenUsage', () => {
  it('subtracts the cached share out of the aggregate prompt count', () => {
    expect(tokenUsage({
      prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 800 },
    })).toEqual({ inputTokens: 200, outputTokens: 50, totalTokens: 1050, cacheReadTokens: 800 })
  })

  it('reads reasoning tokens the proxy reported separately', () => {
    expect(tokenUsage({ prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 15 } }))
      .toEqual({ inputTokens: 10, outputTokens: 20, reasoningTokens: 15 })
  })

  it('never reports a negative input count when the proxy over-reports cache', () => {
    expect(tokenUsage({ prompt_tokens: 10, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 50 } })
      ?.inputTokens).toBe(0)
  })

  it('answers undefined for a chunk carrying no counts', () => {
    expect(tokenUsage(undefined)).toBeUndefined()
    expect(tokenUsage({})).toBeUndefined()
    expect(tokenUsage({ prompt_tokens: 'many' })).toBeUndefined()
    expect(tokenUsage(null)).toBeUndefined()
  })

  it('reads a usage object reporting only one side', () => {
    expect(tokenUsage({ completion_tokens: 7 })).toEqual({ inputTokens: 0, outputTokens: 7 })
    expect(tokenUsage({ prompt_tokens: 7 })).toEqual({ inputTokens: 7, outputTokens: 0 })
  })
})
