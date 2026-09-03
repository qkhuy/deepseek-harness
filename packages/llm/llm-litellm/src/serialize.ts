/**
 * Harness message and tool vocabulary projected onto the OpenAI
 * chat-completions request body LiteLLM accepts.
 *
 * LiteLLM normalizes every upstream provider onto this one wire, so the
 * projection targets the OpenAI dialect exactly rather than any upstream
 * model's own. Two harness shapes have no direct OpenAI counterpart and are
 * resolved here: a tool result lives inside a user-role message and becomes
 * its own `tool` message, and reasoning content is dropped from the request
 * because no provider accepts its own thinking back as input.
 *
 * @module @deepseek-ai/dsh-llm-litellm/src/serialize
 */

import type { ContentBlock, Message, ToolSchema } from '@deepseek-ai/dsh-llm'

/** One `tool_calls` entry in an assistant message. */
export interface WireToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}

/** One message on the chat-completions wire. */
export interface WireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string | null
  readonly tool_calls?: readonly WireToolCall[]
  readonly tool_call_id?: string
}

/**
 * Flatten one block list to the text the wire carries for it. Reasoning is
 * dropped: no provider LiteLLM fronts accepts its own thinking back as input,
 * and sending it would spend context on tokens the model then re-derives.
 */
function blockText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'reasoning':
        break
      case 'image':
        // The runtime projects images to text before a text-only route sees
        // them; a block still here belongs to a request this adapter declared
        // it could not carry visually, so its identity is what the model gets.
        parts.push(`[image attachment ${block.attachment.attachmentId}]`)
        break
      case 'tool-call':
      case 'tool-result':
        // Both are carried by dedicated wire fields, never by message text.
        break
      default:
        // Merge-extensible union: an unknown block contributes no text rather
        // than failing a request whose other content is serviceable.
        break
    }
  }
  return parts.join('\n')
}

/** Whether a tool result reports failure, which the wire can only state in the text. */
function toolResultText(content: readonly ContentBlock[], isError: boolean): string {
  const text = blockText(content)
  return isError ? `Error: ${text}` : text
}

/**
 * Project the harness conversation onto chat-completions messages.
 *
 * The system prompt is prepended as a `system` message rather than merged into
 * the first user turn, because LiteLLM forwards the role and each upstream
 * provider applies its own system handling to it.
 * @param messages - the assembled conversation, in request order.
 * @param system - the system prompt, when the request carries one.
 * @returns the wire messages, in the order the proxy must receive them.
 */
export function serializeMessages(
  messages: readonly Message[],
  system?: string,
): readonly WireMessage[] {
  const wire: WireMessage[] = []
  if (system !== undefined && system.length > 0) wire.push({ role: 'system', content: system })
  for (const message of messages) {
    if (message.source.kind === 'tool') {
      const result = message.content.find(block => block.type === 'tool-result')
      // The tool source guarantees the block by construction; the guard exists
      // for hand-built requests, which the seam does not type-check.
      if (result === undefined) continue
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: toolResultText(result.content, result.isError === true),
      })
      continue
    }
    if (message.role === 'assistant') {
      const calls = message.content
        .filter(block => block.type === 'tool-call')
        .map((block): WireToolCall => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        }))
      const text = blockText(message.content)
      wire.push({
        role: 'assistant',
        // OpenAI requires null, not an empty string, when an assistant turn is
        // tool calls alone.
        content: text.length === 0 && calls.length > 0 ? null : text,
        ...calls.length === 0 ? {} : { tool_calls: calls },
      })
      continue
    }
    wire.push({ role: message.role === 'system' ? 'system' : 'user', content: blockText(message.content) })
  }
  return wire
}

/**
 * Project harness tool schemas onto the OpenAI `tools` field.
 * @param tools - the tools offered for this request.
 * @returns the wire tool declarations, or `undefined` when none were offered.
 */
export function serializeTools(tools: readonly ToolSchema[] | undefined): unknown[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}
