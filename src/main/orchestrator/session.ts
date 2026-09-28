import { EventEmitter } from 'events'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
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

  constructor(projectPath: string) {
    super()

    const codexServer = createCodexDelegationServer(projectPath, (note) => {
      const event: VibeEvent = { type: 'delegation_progress', toolUseId: '', note }
      this.emit('event', event)
    })

    this.queryHandle = query({
      prompt: this.queue,
      options: {
        cwd: projectPath,
        permissionMode: 'acceptEdits',
        mcpServers: { vibe_tools: codexServer },
        canUseTool: async (toolName, input) => {
          if (isLikelyDestructive(toolName, input)) {
            const approved = await this.requestConfirmation(toolName, input)
            return approved
              ? { behavior: 'allow' as const }
              : { behavior: 'deny' as const, message: 'User declined this action' }
          }
          return { behavior: 'allow' as const }
        }
      }
    })

    this.consume()
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.queryHandle) {
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

export function getOrCreateSession(projectId: string, projectPath: string): ClaudeSession {
  const existing = sessions.get(projectId)
  if (existing) return existing
  const session = new ClaudeSession(projectPath)
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
