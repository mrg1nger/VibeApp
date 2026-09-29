import { EventEmitter } from 'events'
import { watch, type FSWatcher } from 'fs'
import { dirname, join } from 'path'
import {
  query,
  type SDKUserMessage,
  type HookCallback,
  type PreToolUseHookInput
} from '@anthropic-ai/claude-agent-sdk'
import type { VibeEvent } from '@shared/types'
import { mapSdkMessage } from './eventSchema'
import { createCodexDelegationServer } from '../delegation/codexTool'
import { globalMemoryPath, projectMemoryPath, memoryServerScriptPath } from '../memory/paths'

/**
 * The SDK locates its native binary relative to its own module URL, which in
 * a packaged app points inside app.asar. Electron's fs patch makes that path
 * pass existsSync, but the OS can't spawn a file inside the archive, so the
 * launch fails. Resolve it ourselves and point at the unpacked copy.
 */
function resolveClaudeExecutable(): string | undefined {
  try {
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    const binary = process.platform === 'win32' ? 'claude.exe' : 'claude'
    const resolved = join(dirname(require.resolve(`${pkg}/package.json`)), binary)
    return resolved.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  } catch {
    return undefined
  }
}

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
  private queue: MessageQueue
  private queryHandle!: ReturnType<typeof query>
  private capturedSessionId: string | undefined
  private goNutz: boolean
  private disposed = false
  private mcpWatcher: FSWatcher | undefined
  private reloadTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly projectId: string,
    private readonly projectPath: string,
    resumeSessionId?: string,
    initialGoNutz = false
  ) {
    super()
    this.goNutz = initialGoNutz
    this.capturedSessionId = resumeSessionId
    this.queue = this.startQuery(resumeSessionId, initialGoNutz)
    this.watchMcpConfig()
  }

  /** (Re)creates the query() session and starts consuming its message stream. */
  private startQuery(resumeSessionId: string | undefined, goNutz: boolean): MessageQueue {
    const memoryPaths = {
      scriptPath: memoryServerScriptPath(),
      projectMemoryPath: projectMemoryPath(this.projectId),
      globalMemoryPath: globalMemoryPath()
    }

    const codexServer = createCodexDelegationServer(
      this.projectPath,
      (note) => {
        const event: VibeEvent = { type: 'delegation_progress', toolUseId: '', note }
        this.emit('event', event)
      },
      () => this.goNutz,
      memoryPaths
    )

    const memoryServer = {
      type: 'stdio' as const,
      // process.execPath is the Electron binary here, not plain Node -- it
      // needs ELECTRON_RUN_AS_NODE set on the child or it tries to boot a
      // full Electron app instead of running the script (see Phase 0 notes
      // on this exact failure mode).
      command: process.execPath,
      args: [memoryPaths.scriptPath, memoryPaths.projectMemoryPath, memoryPaths.globalMemoryPath, 'claude'],
      // Merged over the inherited environment by the CLI; passing all of
      // process.env here would serialize it onto the command line.
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }

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

      // External (non-SDK) MCP servers need an explicit permission grant
      // even under acceptEdits/allowDangerouslySkipPermissions -- confirmed
      // experimentally that a plain `{ continue: true }` from a PreToolUse
      // hook does NOT count as approval for them, unlike the in-process
      // vibe_tools server. Auto-allow every MCP tool call (our own
      // vibe_memory/vibe_tools as well as anything a project's .mcp.json
      // declares, including one Claude installs on its own mid-session) --
      // matches this app's "just do it" default for everything else rather
      // than singling out MCP calls for extra confirmation.
      if (toolInput.tool_name.startsWith('mcp__')) {
        return {
          continue: true,
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
        }
      }

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

    const queue = new MessageQueue()
    this.queryHandle = query({
      prompt: queue,
      options: {
        cwd: this.projectPath,
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        permissionMode: goNutz ? 'bypassPermissions' : 'acceptEdits',
        // Always set so setPermissionMode('bypassPermissions') can be used
        // later to enter Go Nutz mode without recreating the session -- this
        // flag only takes effect once that mode is actually switched to.
        allowDangerouslySkipPermissions: true,
        resume: resumeSessionId,
        mcpServers: { vibe_tools: codexServer, vibe_memory: memoryServer },
        hooks: {
          PreToolUse: [{ hooks: [destructiveCommandGate] }]
        }
      }
    })

    this.consume()
    return queue
  }

  /**
   * Watches the project's .mcp.json for changes and hot-reloads the session
   * on edit. Confirmed experimentally: the SDK auto-loads project .mcp.json
   * at session start (no code needed for that part), but a change written
   * after the session has already started is NOT picked up live -- Claude
   * still can't see a newly-added server until a new query() call is made.
   * Recreating query() with resume: <the session's own id> picks up the new
   * .mcp.json while preserving Claude's conversation context (confirmed:
   * a fact told before the reload was still remembered after).
   */
  private watchMcpConfig(): void {
    // Watch the project directory rather than .mcp.json directly: fs.watch
    // on a path that doesn't exist yet throws immediately, but the common
    // case here is Claude CREATING .mcp.json mid-conversation (installing
    // an MCP server), not editing a pre-existing one -- confirmed
    // experimentally that watching the directory and filtering by filename
    // catches a create (reported as a 'rename' event, normal fs.watch
    // behavior) as well as edits.
    try {
      this.mcpWatcher = watch(this.projectPath, { persistent: false }, (_eventType, filename) => {
        if (filename !== '.mcp.json') return
        // Debounce: editors/writers often emit multiple change events per save.
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => this.reload(), 500)
      })
    } catch {
      // The project directory itself doesn't exist (shouldn't normally
      // happen -- ensureRepo() runs before a session starts) or watching
      // isn't supported on this platform/filesystem; hot-reload is simply
      // unavailable in that case, not a fatal error.
    }
  }

  private reload(): void {
    if (this.disposed) return
    const oldQueue = this.queue
    this.queue = this.startQuery(this.capturedSessionId, this.goNutz)
    oldQueue.close()
    const event: VibeEvent = { type: 'task_progress', note: 'mcp_config_reloaded' }
    this.emit('event', event)
  }

  isGoNutzMode(): boolean {
    return this.goNutz
  }

  async setGoNutzMode(enabled: boolean): Promise<void> {
    this.goNutz = enabled
    await this.queryHandle.setPermissionMode(enabled ? 'bypassPermissions' : 'acceptEdits')
  }

  private async consume(): Promise<void> {
    const queryHandle = this.queryHandle
    try {
      for await (const message of queryHandle) {
        if (queryHandle !== this.queryHandle) return // superseded by a reload
        if ('session_id' in message && message.session_id && message.session_id !== this.capturedSessionId) {
          this.capturedSessionId = message.session_id
          this.emit('session_id', message.session_id)
        }
        for (const event of mapSdkMessage(message)) {
          this.emit('event', event)
        }
      }
    } catch (err) {
      if (queryHandle !== this.queryHandle) return // superseded by a reload
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
    this.disposed = true
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.mcpWatcher?.close()
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
  const session = new ClaudeSession(projectId, projectPath, resumeSessionId, initialGoNutz)
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
