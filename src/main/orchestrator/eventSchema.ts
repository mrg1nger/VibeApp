import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { VibeEvent } from '@shared/types'
import { parsePlanSteps } from '@shared/plan'

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
    case 'mcp__vibe_tools__run_cline_subtask':
      return `Delegated to Cline: ${(input as { prompt?: string })?.prompt ?? 'a subtask'}`
    case 'mcp__vibe_memory__recall': {
      const q = (input as { query?: string })?.query?.trim()
      return q ? `Searched memory: ${q}` : 'Checked key facts'
    }
    case 'mcp__vibe_memory__remember':
      return `Remembered: ${(input as { fact?: string })?.fact ?? 'a fact'}`
    case 'mcp__vibe_memory__where': {
      const q = (input as { query?: string })?.query?.trim()
      return q ? `Looked up where: ${q}` : 'Looked up the code map'
    }
    case 'mcp__vibe_memory__history': {
      const q = (input as { query?: string })?.query?.trim()
      return q ? `Searched the conversation: ${q}` : 'Looked back at the conversation'
    }
    case 'mcp__vibe_memory__handoffs':
      return 'Checked earlier hand-offs'
    case 'mcp__vibe_memory__update':
      return (input as { fact?: string })?.fact ? `Updated memory: ${(input as { fact: string }).fact}` : 'Updated a memory'
    case 'mcp__vibe_memory__forget':
      return `Forgot a memory${(input as { reason?: string })?.reason ? `: ${(input as { reason: string }).reason}` : ''}`
    case 'mcp__vibe_tools__save_deploy_recipe':
      return `Wrote the Deploy steps: ${(input as { name?: string })?.name ?? 'Deploy'}`
    case 'mcp__vibe_tools__save_schedule':
      return `Wrote a schedule: ${(input as { name?: string })?.name ?? 'a schedule'}`
    case 'mcp__vibe_tools__list_schedules':
      return 'Checked the schedules'
    case 'mcp__vibe_memory__todos':
      return 'Checked your to-do list'
    case 'mcp__vibe_memory__add_todo':
      return `Added to your to-do list: ${(input as { text?: string })?.text ?? 'an item'}`
    case 'mcp__vibe_memory__complete_todo':
      return 'Ticked off a to-do'
    case 'mcp__vibe_memory__notes':
      return 'Read your notes'
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
      {
        const agent = input as { subagent_type?: string; description?: string }
        return `Helper${agent?.subagent_type ? ` (${agent.subagent_type})` : ''}: ${agent?.description ?? 'a subtask'}`
      }
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
      const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined
      const blocks = (message.message.content as ContentBlockLike[]) ?? []
      const events: VibeEvent[] = []
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          events.push({ type: 'assistant_text', text: block.text, partial: false })
        } else if (block.type === 'tool_use' && block.name === 'ExitPlanMode' && block.id && !parent) {
          // Plan mode: the plan itself, for the user to approve.
          const plan = String((block.input as { plan?: string })?.plan ?? '').trim()
          events.push({ type: 'plan_proposed', toolUseId: block.id, plan, steps: parsePlanSteps(plan) })
        } else if (block.type === 'tool_use' && block.name && block.id) {
          events.push({
            type: 'tool_call',
            toolUseId: block.id,
            name: block.name,
            input: block.input,
            friendlyLabel: friendlyToolLabel(block.name, block.input),
            ...(parent ? { parentToolUseId: parent } : {})
          })
        }
      }
      return events
    }

    case 'user': {
      const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined
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
            raw: block.content,
            ...(parent ? { parentToolUseId: parent } : {})
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
