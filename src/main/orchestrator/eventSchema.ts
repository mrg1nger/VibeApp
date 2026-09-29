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
    case 'AskUserQuestion': {
      const first = (input as { questions?: { question?: string }[] })?.questions?.[0]?.question
      return first ? `Asked you: ${first}` : 'Asked you a question'
    }
    case 'mcp__vibe_tools__run_codex_subtask':
      return `Delegated to Codex: ${(input as { prompt?: string })?.prompt ?? 'a subtask'}`
    case 'mcp__vibe_memory__recall':
      return 'Checked memory'
    case 'mcp__vibe_memory__remember':
      return `Remembered: ${(input as { fact?: string })?.fact ?? 'a fact'}`
    case 'MultiEdit':
      return `Edited ${(input as { file_path?: string })?.file_path ?? 'a file'}`
    case 'NotebookEdit':
      return `Edited ${(input as { notebook_path?: string })?.notebook_path ?? 'a notebook'}`
    case 'TodoWrite':
      return 'Updated its to-do list'
    case 'WebFetch':
      return `Read web page: ${(input as { url?: string })?.url ?? ''}`.trim()
    case 'WebSearch':
      return `Searched the web: ${(input as { query?: string })?.query ?? ''}`.trim()
    case 'Task':
    case 'Agent':
      return `Started a helper: ${(input as { description?: string })?.description ?? 'a subtask'}`
    default: {
      // Other MCP tools: "mcp__github__create_issue" -> "github: create issue".
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      return mcp ? `${mcp[1]}: ${mcp[2].replace(/_/g, ' ')}` : name
    }
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
