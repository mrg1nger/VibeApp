import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { VibeEvent } from '@shared/types'

interface ContentBlockLike {
  type: string
  text?: string
  name?: string
  input?: unknown
  id?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function friendlyToolLabel(name: string, input: unknown): string {
  switch (name) {
    case 'Read':
      return `Read ${(input as { file_path?: string })?.file_path ?? 'a file'}`
    case 'Write':
      return `Wrote ${(input as { file_path?: string })?.file_path ?? 'a file'}`
    case 'Edit':
      return `Edited ${(input as { file_path?: string })?.file_path ?? 'a file'}`
    case 'Bash':
    case 'PowerShell':
      return `Ran: ${(input as { command?: string })?.command ?? 'a command'}`
    case 'Glob':
    case 'Grep':
      return `Searched files`
    case 'mcp__vibe_tools__run_codex_subtask':
      return `Delegated to Codex: ${(input as { prompt?: string })?.prompt ?? 'a subtask'}`
    default:
      return name
  }
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 200)
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null)
      .map((b) => ('text' in b ? b.text : ''))
      .join(' ')
    return text.slice(0, 200)
  }
  return ''
}

/** Maps a raw SDK message to zero or more app-level VibeEvents for the renderer. */
export function mapSdkMessage(message: SDKMessage): VibeEvent[] {
  switch (message.type) {
    case 'assistant': {
      const blocks = (message.message.content as ContentBlockLike[]) ?? []
      const events: VibeEvent[] = []
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          events.push({ type: 'assistant_text', text: block.text, partial: false })
        } else if (block.type === 'tool_use' && block.name && block.id) {
          events.push({
            type: 'tool_call',
            toolUseId: block.id,
            name: block.name,
            input: block.input,
            friendlyLabel: friendlyToolLabel(block.name, block.input)
          })
        }
      }
      return events
    }

    case 'user': {
      const content = message.message.content
      if (!Array.isArray(content)) return []
      const events: VibeEvent[] = []
      for (const block of content as ContentBlockLike[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          events.push({
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            ok: !block.is_error,
            summary: summarizeToolResult(block.content),
            raw: block.content
          })
        }
      }
      return events
    }

    case 'result': {
      if (message.subtype === 'success') {
        return [{ type: 'turn_complete' }]
      }
      return [
        { type: 'error', message: message.errors.join('\n') || 'The turn ended with an error' },
        { type: 'turn_complete' }
      ]
    }

    default:
      return []
  }
}
