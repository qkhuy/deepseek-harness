import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { Message, ToolCallId } from '@deepseek-ai/dsh-llm'
import { serializeMessages, serializeTools } from '../src/index.ts'

const callId = brandString<ToolCallId>('call_1')

const user = (text: string): Message => createMessage({
  role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' },
})

const assistant = (content: Message['content']): Message => createMessage({
  role: 'assistant', content, source: { kind: 'model', provider: 'litellm', model: 'gpt-4o' },
})

const toolResult = (text: string, isError?: boolean): Message => createMessage({
  role: 'user',
  content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], ...isError === undefined ? {} : { isError } }],
  source: { kind: 'tool', callId },
})

describe('serializeMessages', () => {
  it('puts the system prompt in its own role, ahead of the conversation', () => {
    expect(serializeMessages([user('hi')], 'be brief')).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('sends no system message when the request carries none', () => {
    expect(serializeMessages([user('hi')])).toEqual([{ role: 'user', content: 'hi' }])
    expect(serializeMessages([user('hi')], '')).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('lifts a tool result out of its user message into a tool message', () => {
    expect(serializeMessages([toolResult('42')])).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: '42' },
    ])
  })

  it('states a failed tool result in the only field the wire has for it', () => {
    expect(serializeMessages([toolResult('boom', true)])[0]?.content).toBe('Error: boom')
  })

  it('carries assistant tool calls in tool_calls with a null content', () => {
    expect(serializeMessages([assistant([
      { type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"a"}' },
    ])])).toEqual([{
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
    }])
  })

  it('keeps assistant text beside its tool calls', () => {
    const wire = serializeMessages([assistant([
      { type: 'text', text: 'reading now' },
      { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
    ])])
    expect(wire[0]?.content).toBe('reading now')
    expect(wire[0]?.tool_calls).toHaveLength(1)
  })

  it('drops reasoning, which no provider accepts back as input', () => {
    expect(serializeMessages([assistant([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer' },
    ])])[0]?.content).toBe('answer')
  })

  it('names an image the runtime did not project, rather than dropping it silently', () => {
    const message = createMessage({
      role: 'user',
      content: [{
        type: 'image',
        attachment: {
          attachmentId: brandString<AttachmentId>('att-1'), mediaType: 'image/png', bytes: 10, width: 2, height: 2,
        },
      }],
      source: { kind: 'user' },
    })
    expect(serializeMessages([message])[0]?.content).toBe('[image attachment att-1]')
  })

  it('sends a system-role history message as system', () => {
    const message = createMessage({
      role: 'system', content: [{ type: 'text', text: 'rule' }], source: { kind: 'user' },
    })
    expect(serializeMessages([message])[0]?.role).toBe('system')
  })

  it('joins several text blocks with newlines', () => {
    expect(serializeMessages([user('a')].concat(assistant([
      { type: 'text', text: 'one' }, { type: 'text', text: 'two' },
    ])))[1]?.content).toBe('one\ntwo')
  })

  it('contributes no text for a tool-result or unrecognized block reached by construction, not routing', () => {
    // Neither shape appears in an assistant message's content in practice —
    // tool-result blocks live inside a tool-kind source message, and no
    // producer emits an unknown block type — but ContentBlock is
    // merge-extensible, so the switch must still fall through both instead of
    // throwing on a block position the type system does not forbid.
    const exotic = assistant([
      { type: 'text', text: 'before' },
      { type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'nested' }] },
      { type: 'unknown-future-block' } as unknown as Message['content'][number],
      { type: 'text', text: 'after' },
    ])
    expect(serializeMessages([exotic])[0]?.content).toBe('before\nafter')
  })

  it('drops a tool-kind message whose content carries no tool-result block', () => {
    // The tool source guarantees the block by construction; a hand-built
    // request the seam does not type-check can omit it.
    const malformed = createMessage({
      role: 'user',
      content: [{ type: 'text', text: 'not a tool result' }],
      source: { kind: 'tool', callId },
    })
    expect(serializeMessages([malformed])).toEqual([])
  })
})

describe('serializeTools', () => {
  it('projects tool schemas onto the OpenAI function form', () => {
    expect(serializeTools([{ name: 'read', description: 'read a file', parameters: { type: 'object' } }])).toEqual([
      { type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object' } } },
    ])
  })

  it('sends no tools field when the request offers none', () => {
    expect(serializeTools(undefined)).toBeUndefined()
    expect(serializeTools([])).toBeUndefined()
  })
})
