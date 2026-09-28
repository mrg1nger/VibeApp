import { EventEmitter } from 'events'
import {
  query,
  type SDKUserMessage,
  type HookCallback,
  type PreToolUseHookInput
} from '@anthropic-ai/claude-agent-sdk'
import type { VibeEvent } from '@shared/types'
import { mapSdkMessage } from './eventSchema'
import { createCodexDelegationServer } from '../delegation/codexTool'

/** A pushable async queue feeding query()'s streaming-input mode. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = []
  private waiters: Array<(msg: SDKUserMessage) => void> = []
  private closed = false

  push(text: string): void {
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null
    }
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(message)
    } else {
      this.pending.push(message)
    }
  }

  close(): void {
    this.closed = true
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.closed) {
      if (this.pending.length > 0) {
        yield this.pending.shift()!
        continue
      }
      const message = await new Promise<SDKUserMessage | null>((resolve) => {
        this.waiters.push(resolve as (msg: SDKUserMessage) => void)
        // Allow close() to unblock a waiting iterator.
        const checkClosed = setInterval(() => {
          if (this.closed) {
            clearInterval(checkClosed)
            resolve(null)
          }
        }, 100)
      })
      if (message) yield message
    }
  }
}

export class ClaudeSession extends EventEmitter {
  private queue = new MessageQueue()
  private queryHandle: ReturnType<typeof query>
  private capturedSessionId: string | undefined
  private goNutz: boolean

  constructor(projectPath: string, resumeSessionId?: string, initialGoNutz = false) {
    super()
    this.goNutz = initialGoNutz

    const codexServer = createCodexDelegationServer(
      projectPath,
      (note) => {
        const event: VibeEvent = { type: 'delegation_progress', toolUseId: '', note }
        this.emit('event', event)
      },
      () => this.goNutz
    )

    // canUseTool is NOT called for a Bash command that stays inside the
    // session's allowed directories -- it only fires when Claude Code's own
    // path-boundary check flags a command as reaching outside them. A
    // destructive-command gate needs PreToolUse instead, which fires for
    // every tool use regardless of path. Confirmed experimentally: unlike
    // canUseTool, a PreToolUse hook is NOT skipped by permissionMode:
    // 'bypassPermissions', so the hook itself has to check goNutz and no-op
    // when Go Nutz mode is on.
    const destructiveCommandGate: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return { continue: true }
      const toolInput = input as PreToolUseHookInput
      if (this.goNutz || !isLikelyDestructive(toolInput.tool_name, toolInput.tool_input)) {
        return { continue: true }
      }
      const approved = await this.requestConfirmation(toolInput.tool_name, toolInput.tool_input)
      if (approved) return { continue: true }
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'User declined this action'
        }
      }
    }

    this.queryHandle = query({
      prompt: this.queue,
      options: {
        cwd: projectPath,
        permissionMode: initialGoNutz ? 'bypassPermissions' : 'acceptEdits',
        // Always set so setPermissionMode('bypassPermissions') can be used
        // later to enter Go Nutz mode without recreating the session -- this
        // flag only takes effect once that mode is actually switched to.
        allowDangerouslySkipPermissions: true,
        resume: resumeSessionId,
        mcpServers: { vibe_tools: codexServer },
        hooks: {
          PreToolUse: [{ hooks: [destructiveCommandGate] }]
        }
      }
    })

    this.consume()
  }

  isGoNutzMode(): boolean {
    return this.goNutz
  }

  async setGoNutzMode(enabled: boolean): Promise<void> {
    this.goNutz = enabled
    await this.queryHandle.setPermissionMode(enabled ? 'bypassPermissions' : 'acceptEdits')
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.queryHandle) {
        if ('session_id' in message && message.session_id && message.session_id !== this.capturedSessionId) {
          this.capturedSessionId = message.session_id
          this.emit('session_id', message.session_id)
        }
        for (const event of mapSdkMessage(message)) {
          this.emit('event', event)
        }
      }
    } catch (err) {
      const event: VibeEvent = { type: 'error', message: (err as Error).message }
      this.emit('event', event)
    }
  }

  private confirmationWaiters = new Map<string, (approved: boolean) => void>()

  private requestConfirmation(toolName: string, input: unknown): Promise<boolean> {
    return new Promise((resolve) => {
      const id = `${toolName}-${Date.now()}`
      this.confirmationWaiters.set(id, resolve)
      this.emit('confirmation_request', { id, toolName, input })
    })
  }

  resolveConfirmation(id: string, approved: boolean): void {
    const resolver = this.confirmationWaiters.get(id)
    if (resolver) {
      resolver(approved)
      this.confirmationWaiters.delete(id)
    }
  }

  send(text: string): void {
    this.queue.push(text)
  }

  async abort(): Promise<void> {
    await this.queryHandle.interrupt()
  }

  dispose(): void {
    this.queue.close()
  }
}

const DESTRUCTIVE_BASH_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bgit\s+push\s+.*--force/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bdrop\s+(table|database)\b/i,
  /\bformat\b.*[a-z]:/i
]

function isLikelyDestructive(toolName: string, input: unknown): boolean {
  if (toolName !== 'Bash') return false
  const command = (input as { command?: string })?.command ?? ''
  return DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(command))
}

const sessions = new Map<string, ClaudeSession>()

export function getOrCreateSession(
  projectId: string,
  projectPath: string,
  resumeSessionId?: string,
  initialGoNutz = false
): ClaudeSession {
  const existing = sessions.get(projectId)
  if (existing) return existing
  const session = new ClaudeSession(projectPath, resumeSessionId, initialGoNutz)
  sessions.set(projectId, session)
  return session
}

export function getSession(projectId: string): ClaudeSession | undefined {
  return sessions.get(projectId)
}

export function disposeSession(projectId: string): void {
  sessions.get(projectId)?.dispose()
  sessions.delete(projectId)
}
