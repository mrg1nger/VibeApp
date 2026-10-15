import { EventEmitter } from 'events'
import { watch, type FSWatcher } from 'fs'
import { randomUUID } from 'crypto'
import {
  query,
  type SDKUserMessage,
  type HookCallback,
  type PreToolUseHookInput
} from '@anthropic-ai/claude-agent-sdk'
import type { ConfirmationRequest, QuestionAnswers, UserQuestion, VibeEvent } from '@shared/types'
import { mapSdkMessage } from './eventSchema'
import { createCodexDelegationServer } from '../delegation/codexTool'
import { memoryDb, memoryDbPath, memoryServerScriptPath } from '../memory/paths'
import { activeExtensions, extensionInstructions } from '../extensions/store'
import { installExtensionForAgent } from '../extensions/install'
import { keyFactsBlock } from '../memory/store'
import { resolveClaudeExecutable } from '../cli/claudeBinary'
import { getSettings } from '../settings/store'
import { agentSecretEnv, listSecrets } from '../secrets/vault'
import type { PreparedImage } from '../attachments/images'
import type { CodexThread, RequestContext } from '../delegation/codexTool'
import { countsFromSdkResult, recordUsage } from '../usage/tokens'

function memoryInstructions(autoMemory: boolean): string {
  const saving = autoMemory
    ? "2. VibeApp saves lasting facts from each request automatically after you reply, so don't spend a step on it: call mcp__vibe_memory__remember only when the user asks you to remember something."
    : '2. Before your final reply, call mcp__vibe_memory__remember for each new lasting fact you learned or decided: what the project is, how to run/build/test/deploy it, decisions and why, the user\'s stated preferences, and non-obvious gotchas. One standalone sentence each, with a category; mark key: true only for facts needed on almost every request. Skip anything already remembered.'
  return MEMORY_INSTRUCTIONS_TEMPLATE.replace('{{SAVING}}', saving)
}

const MEMORY_INSTRUCTIONS_TEMPLATE = `# Project memory
You share a persistent memory with Codex through the mcp__vibe_memory tools. The key facts are listed below; more facts are stored than shown.
1. When the request touches something the key facts don't cover (a feature, file, bug, or past decision), call mcp__vibe_memory__recall with a short search first, e.g. "inventory" or "deploy".
{{SAVING}}
3. If a remembered fact turns out to be wrong or out of date, fix it with mcp__vibe_memory__update (or mcp__vibe_memory__forget), using its id. Don't save a new fact that contradicts an old one.
4. Never save secrets, credentials, or temporary task state. Use global: true only for preferences that apply to all the user's projects.
5. For trivial quick edits, don't save anything to memory.
6. To find where something lives in the code, call mcp__vibe_memory__where first (a map of the source files, each with a one-line summary) instead of searching files yourself. To look up what the user said earlier, use mcp__vibe_memory__history; to see what Codex did in earlier hand-offs, use mcp__vibe_memory__handoffs.`

const APP_INSTRUCTIONS = `# Live preview
VibeApp shows the user a live preview of their project next to this chat. It starts the preview with \`npm run dev\` (or \`npm start\`) when package.json has that script, otherwise it serves index.html from the project root. For web projects, keep one of those working so the user can see the result, and have dev servers print their local URL. Don't start long-running dev servers yourself; VibeApp runs them.
Messages may start with bracketed notes from VibeApp (for example, an element the user pointed at in the preview, or remembered facts and files that look relevant to the request). Use them as context; they're not something the user typed. Notes from a search are hints: check them against the code before relying on them.
Codex is automatically given the user's original request, the key facts and recent hand-offs when you hand it a task, so a task only needs to say what to do, which files are involved, and what done looks like.
VibeApp doesn't commit anything for the user, so the working tree usually holds uncommitted work from earlier requests (some done by Codex while you were unavailable). A whole-tree git diff or git status therefore shows much more than the current request changed. Judge what a request changed from hand-off results, which list their own files and diff, and don't try to untangle or revert earlier uncommitted work unless asked.
If the user wants a new tool for you and Codex ("add a tool that...", "make an MCP server for..."), build it as a small MCP server in the project, then call mcp__vibe_tools__install_extension so it's available everywhere. Don't edit .mcp.json for that: servers listed there are only seen by you in this project.`

function secretsInstructions(projectId: string): string {
  let names: string[] = []
  try {
    names = listSecrets(projectId).map((s) => s.name)
  } catch {
    // Vault unreadable; Claude just won't be told about any secrets.
  }
  return `

# Secrets
The user keeps API keys and other secrets in VibeApp's Secrets panel (the 🔑 button in the chat header), not in project files. ${
    names.length
      ? `This project has: ${names.join(', ')}. VibeApp sets them as environment variables when it runs the app preview and when you run commands (except ANTHROPIC_*/CLAUDE_* ones, which only the app gets).`
      : 'This project has none yet.'
  }
- Read secrets from the environment (process.env.NAME in Node; in Vite client code the name needs a VITE_ prefix and is read with import.meta.env.VITE_NAME). Never hard-code a secret value in a file, and never print, echo, or log one.
- Don't create .env files with real values. If the app needs a new secret, tell the user its name and ask them to add it in the Secrets panel; don't ask them to paste it into the chat.
- Anything in client-side (browser) code is visible to everyone who uses the app, so keys that must stay private belong in server-side code.`
}

/** A pushable async queue feeding query()'s streaming-input mode. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = []
  private waiter: ((msg: SDKUserMessage | null) => void) | undefined
  private closed = false

  push(content: SDKUserMessage['message']['content']): void {
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null
    }
    const waiter = this.waiter
    this.waiter = undefined
    if (waiter) {
      waiter(message)
    } else {
      this.pending.push(message)
    }
  }

  close(): void {
    this.closed = true
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.(null)
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.closed) {
      if (this.pending.length > 0) {
        yield this.pending.shift()!
        continue
      }
      const message = await new Promise<SDKUserMessage | null>((resolve) => {
        this.waiter = resolve
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
  private dead = false
  private turnsInFlight = 0
  /** Set by stop() until the interrupted turn's result arrives. */
  private stopping = false
  /** Cancels running Codex hand-offs when the user presses Stop. */
  private delegationAbort = new AbortController()
  private reloadPending = false
  /** Whether the pending reload is for .mcp.json (shown in the chat) rather than secrets. */
  private reloadAnnounce = false
  private mcpWatcher: FSWatcher | undefined
  private reloadTimer: NodeJS.Timeout | undefined
  private activeModel: string | null = null
  /** The user's current request in their own words, passed along with Codex hand-offs. */
  private requestContext: RequestContext | undefined

  /** When the plan limit says Claude is usable again (epoch ms), from the last rate-limit event. */
  private limitResetsAt: number | undefined
  /** The limit has been reported for the current request. */
  private limitReported = false

  /** The Codex session this request's hand-offs share (reset by each new request). */
  private codexThread: CodexThread | undefined
  /** Size of the conversation Claude last saw, in tokens (from its latest API call). */
  private lastContextTokens = 0

  setRequestContext(context: RequestContext | undefined): void {
    this.requestContext = context
    this.codexThread = undefined
  }

  contextTokens(): number {
    return this.lastContextTokens
  }

  /**
   * Moves the conversation into a brand-new Claude session, so it stops
   * re-reading a very long history on every step. Only between requests;
   * the caller carries the earlier conversation over as a summary.
   */
  rotate(summary?: string): boolean {
    if (this.dead || this.disposed || this.turnsInFlight > 0) return false
    const before = this.lastContextTokens
    const old = this.queue
    this.capturedSessionId = undefined
    this.lastContextTokens = 0
    this.queue = this.startQuery(undefined, this.goNutz)
    old.close()
    this.emit('event', { type: 'session_rotated', contextTokens: before, summary } satisfies VibeEvent)
    return true
  }

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
      dbPath: memoryDbPath(),
      projectId: this.projectId,
      projectPath: this.projectPath
    }
    // Key facts go straight into the instructions (cached by Claude Code
    // across turns) instead of costing a recall on every request. Opening
    // the database here also moves any old JSON memory in before the memory
    // server (a separate process) first reads it. A broken database costs
    // memory, not the chat.
    let keyFacts = '(Memory is unavailable right now.)'
    try {
      keyFacts = keyFactsBlock(memoryDb(), this.projectId)
    } catch (err) {
      console.warn('Reading key facts failed:', (err as Error).message)
    }

    const codexServer = createCodexDelegationServer(
      this.projectPath,
      (note) => {
        const event: VibeEvent = { type: 'delegation_progress', toolUseId: '', note }
        this.emit('event', event)
      },
      () => this.goNutz,
      memoryPaths,
      () => this.delegationAbort.signal,
      () => this.requestContext,
      { get: () => this.codexThread, set: (thread) => (this.codexThread = thread) },
      (activity) => {
        const event: VibeEvent = { type: 'delegation_activity', activity }
        this.emit('event', event)
      },
      async (req) => {
        const result = await installExtensionForAgent(req, this.projectPath, ({ reason, input }) =>
          this.requestConfirmation('install_extension', input, reason)
        )
        if (result.ok) refreshExtensionsForAllSessions()
        return result
      }
    )

    const memoryServer = {
      type: 'stdio' as const,
      // process.execPath is the Electron binary here, not plain Node -- it
      // needs ELECTRON_RUN_AS_NODE set on the child or it tries to boot a
      // full Electron app instead of running the script (see Phase 0 notes
      // on this exact failure mode).
      command: process.execPath,
      args: [memoryPaths.scriptPath, memoryPaths.dbPath, memoryPaths.projectId, 'claude', memoryPaths.projectPath],
      // Merged over the inherited environment by the CLI; passing all of
      // process.env here would serialize it onto the command line.
      env: { ELECTRON_RUN_AS_NODE: '1' },
      // MCP tools are otherwise deferred behind tool search, and Claude
      // skipped the memory instructions when it had to go looking first.
      alwaysLoad: true
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
      const approved = await this.requestConfirmation(
        toolInput.tool_name,
        toolInput.tool_input,
        `Claude wants to run a potentially destructive command via ${toolInput.tool_name}.`
      )
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

    // Tools the user installed once for every project (Extensions screen).
    const extensions = activeExtensions()
    const extensionServers = Object.fromEntries(
      extensions.map((e) => [e.server, { type: 'stdio' as const, command: e.command, args: e.args, env: e.env }])
    )

    const queue = new MessageQueue()
    this.activeModel = getSettings().claudeModel
    this.queryHandle = query({
      prompt: queue,
      options: {
        cwd: this.projectPath,
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        model: this.activeModel ?? undefined,
        // Replaces the inherited environment, so start from process.env.
        env: { ...process.env, ...agentSecretEnv(this.projectId) },
        permissionMode: goNutz ? 'bypassPermissions' : 'acceptEdits',
        // Always set so setPermissionMode('bypassPermissions') can be used
        // later to enter Go Nutz mode without recreating the session -- this
        // flag only takes effect once that mode is actually switched to.
        allowDangerouslySkipPermissions: true,
        resume: resumeSessionId,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: `${memoryInstructions(getSettings().autoMemory)}\n\n## Key facts\n${keyFacts}\n\n${APP_INSTRUCTIONS}${secretsInstructions(this.projectId)}${extensionInstructions(extensions) ? `

${extensionInstructions(extensions)}` : ''}`
        },
        mcpServers: { ...extensionServers, vibe_tools: codexServer, vibe_memory: memoryServer },
        // Only called when Claude Code itself wants to ask (sensitive files
        // like .mcp.json, paths outside the project). With no handler those
        // requests were silently denied.
        canUseTool: async (toolName, input, options) => {
          // Claude asking the user something comes through here too. The
          // answers go back to it inside the tool's input.
          if (toolName === 'AskUserQuestion') {
            const answers = await this.requestAnswers(input)
            return answers
              ? { behavior: 'allow', updatedInput: { ...input, answers } }
              : {
                  behavior: 'deny',
                  message: "The user skipped these questions. Continue with your best judgment, or ask in plain text if you're blocked."
                }
          }
          const filePath = (input as { file_path?: string }).file_path ?? ''
          if (/(^|[\\/])\.mcp\.json$/.test(filePath)) {
            // Lets Claude install MCP servers; watchMcpConfig reloads them.
            return { behavior: 'allow', updatedInput: input }
          }
          const approved = await this.requestConfirmation(
            toolName,
            input,
            options.title ?? `Claude wants to use ${toolName}.`
          )
          return approved
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'The user declined this action.' }
        },
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
        this.reloadTimer = setTimeout(() => this.requestReload(), 500)
      })
    } catch {
      // The project directory itself doesn't exist (shouldn't normally
      // happen -- ensureRepo() runs before a session starts) or watching
      // isn't supported on this platform/filesystem; hot-reload is simply
      // unavailable in that case, not a fatal error.
    }
  }

  // Claude usually edits .mcp.json in the middle of a turn. Reloading then
  // would abandon that turn (its result is ignored once superseded) and leave
  // the UI waiting forever, so wait until no turn is running.
  private requestReload(announce = true): void {
    if (announce) this.reloadAnnounce = true
    if (this.turnsInFlight > 0) {
      this.reloadPending = true
      return
    }
    this.reload()
  }

  private reload(): void {
    if (this.disposed || this.dead) return
    const announce = this.reloadAnnounce
    this.reloadPending = false
    this.reloadAnnounce = false
    const oldQueue = this.queue
    this.queue = this.startQuery(this.capturedSessionId, this.goNutz)
    oldQueue.close()
    if (announce) {
      const event: VibeEvent = { type: 'task_progress', note: 'mcp_config_reloaded' }
      this.emit('event', event)
    }
  }

  /** Extensions changed: restart Claude Code (keeping the conversation) so it loads the new tool list. */
  refreshExtensions(): void {
    this.requestReload(false)
  }

  /** Secrets changed: restart Claude Code (keeping the conversation) so it gets the new environment. */
  refreshSecrets(): void {
    this.requestReload(false)
  }

  isDead(): boolean {
    return this.dead
  }

  getCapturedSessionId(): string | undefined {
    return this.capturedSessionId
  }

  isGoNutzMode(): boolean {
    return this.goNutz
  }

  async setModel(model: string | null): Promise<void> {
    if (this.dead || this.disposed) return
    await this.queryHandle.setModel(model ?? undefined)
    this.activeModel = model
  }

  /** Switches model for the next message only if it differs; null = the user's chosen model. */
  async useModel(model: string | null): Promise<void> {
    const target = model ?? getSettings().claudeModel
    if (target !== this.activeModel) await this.setModel(target)
  }

  async setGoNutzMode(enabled: boolean): Promise<void> {
    this.goNutz = enabled
    await this.queryHandle.setPermissionMode(enabled ? 'bypassPermissions' : 'acceptEdits')
  }

  private async consume(): Promise<void> {
    const queryHandle = this.queryHandle
    let failure: string | undefined
    try {
      for await (const message of queryHandle) {
        if (queryHandle !== this.queryHandle) return // superseded by a reload
        if ('session_id' in message && message.session_id && message.session_id !== this.capturedSessionId) {
          this.capturedSessionId = message.session_id
          this.emit('session_id', message.session_id)
        }
        // Plan limit reached: report it as itself (not as a crash or a normal
        // reply) so VibeApp can hand the request to Codex.
        if (message.type === 'rate_limit_event') {
          const info = (message as { rate_limit_info?: { status?: string; resetsAt?: number } }).rate_limit_info
          if (info?.resetsAt) this.limitResetsAt = info.resetsAt * 1000
        }
        if (isLimitMessage(message)) {
          if (!this.limitReported) {
            this.limitReported = true
            const raw = message as { type: string; result?: string; message?: { content?: { text?: string }[] } }
            const text =
              raw.type === 'result'
                ? String(raw.result ?? '')
                : (raw.message?.content ?? []).map((b) => b.text ?? '').join('')
            this.emit('event', {
              type: 'claude_limit',
              resetsAt: this.limitResetsAt ?? null,
              message: text.trim() || "Claude's usage limit was reached."
            } satisfies VibeEvent)
          }
          if (message.type === 'result') {
            this.turnsInFlight = Math.max(0, this.turnsInFlight - 1)
            this.emit('event', { type: 'turn_complete' } satisfies VibeEvent)
          }
          continue
        }
        if (message.type === 'assistant') {
          // Each API call reports how much it read: that's the conversation's size now.
          const u = (
            message.message as {
              usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
            }
          ).usage
          if (u) {
            this.lastContextTokens =
              (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
          }
        }
        if (message.type === 'result') {
          this.turnsInFlight = Math.max(0, this.turnsInFlight - 1)
          const counts = countsFromSdkResult(message as Parameters<typeof countsFromSdkResult>[0])
          recordUsage(this.projectId, 'request', 'claude', counts)
          this.emit('event', {
            type: 'usage',
            steps: counts.steps,
            fresh: counts.fresh,
            cached: counts.cached,
            output: counts.output,
            model: counts.model
          } satisfies VibeEvent)
        }
        if (message.type === 'result' && this.stopping) {
          this.stopping = false
          this.emit('event', { type: 'stopped' } satisfies VibeEvent)
          this.emit('event', { type: 'turn_complete' } satisfies VibeEvent)
        } else {
          for (const event of mapSdkMessage(message)) {
            this.emit('event', event)
          }
        }
        if (message.type === 'result' && this.reloadPending && this.turnsInFlight === 0) {
          this.reload()
        }
      }
    } catch (err) {
      failure = (err as Error).message
      // The SDK throws after a limit error result; that was already reported.
      if (this.limitReported) failure = undefined
    }
    if (queryHandle !== this.queryHandle || this.disposed) return
    // The Claude process is gone (crash, launch failure, auth error). Mark
    // the session dead so the next message starts a fresh one, and end the
    // current turn so the UI doesn't wait forever.
    this.dead = true
    this.queue.close()
    if (this.turnsInFlight > 0 || failure) {
      this.turnsInFlight = 0
      if (failure) this.emit('event', { type: 'error', message: failure } satisfies VibeEvent)
      this.emit('event', { type: 'turn_complete' } satisfies VibeEvent)
    }
  }

  private confirmationWaiters = new Map<
    string,
    { resolve: (approved: boolean, answers?: QuestionAnswers) => void; request: ConfirmationRequest }
  >()

  private requestConfirmation(toolName: string, input: unknown, reason: string): Promise<boolean> {
    return new Promise((resolve) => {
      const request: ConfirmationRequest = { id: randomUUID(), toolName, input, reason }
      this.confirmationWaiters.set(request.id, { resolve: (approved) => resolve(approved), request })
      this.emit('confirmation_request', request)
    })
  }

  /** Shows Claude's questions to the user; resolves with their answers, or null if they skipped. */
  private requestAnswers(input: unknown): Promise<QuestionAnswers | null> {
    const questions = ((input as { questions?: UserQuestion[] })?.questions ?? []).filter(
      (q) => q && typeof q.question === 'string'
    )
    return new Promise((resolve) => {
      const request: ConfirmationRequest = {
        id: randomUUID(),
        toolName: 'AskUserQuestion',
        input,
        reason: 'Claude has a question for you.',
        questions
      }
      this.confirmationWaiters.set(request.id, {
        resolve: (approved, answers) => resolve(approved && answers ? answers : null),
        request
      })
      this.emit('confirmation_request', request)
    })
  }

  /** Confirmations still waiting on the user, so a remounted chat can show them again. */
  pendingConfirmations(): ConfirmationRequest[] {
    return [...this.confirmationWaiters.values()].map((w) => w.request)
  }

  resolveConfirmation(id: string, approved: boolean, answers?: QuestionAnswers): void {
    const waiter = this.confirmationWaiters.get(id)
    if (waiter) {
      waiter.resolve(approved, answers)
      this.confirmationWaiters.delete(id)
    }
  }

  /** Sends a message; images (Claude image content blocks) go ahead of the text. */
  send(text: string, images: PreparedImage['block'][] = []): void {
    this.limitReported = false
    this.turnsInFlight++
    this.queue.push(images.length ? [...images, { type: 'text', text }] : text)
  }

  isBusy(): boolean {
    return this.turnsInFlight > 0
  }

  /**
   * The user's Stop button. Interrupting ends the turn with an
   * error_during_execution result (confirmed experimentally), which consume()
   * reports as "stopped" rather than an error; the session stays usable.
   */
  async stop(): Promise<void> {
    if (this.dead || this.disposed || this.turnsInFlight === 0) return
    this.stopping = true
    // Codex runs inside a tool call; interrupting Claude doesn't end it.
    this.delegationAbort.abort()
    this.delegationAbort = new AbortController()
    // Unanswered prompts would otherwise hold the turn open.
    for (const { resolve } of this.confirmationWaiters.values()) resolve(false)
    this.confirmationWaiters.clear()
    await this.queryHandle.interrupt()
  }

  dispose(): void {
    this.disposed = true
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.mcpWatcher?.close()
    for (const { resolve } of this.confirmationWaiters.values()) resolve(false)
    this.confirmationWaiters.clear()
    this.queue.close()
  }
}

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i,
  /\bgit\s+push\s+.*(--force|-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bdrop\s+(table|database)\b/i,
  /\bformat(-volume)?\b.*[a-z]:/i,
  // PowerShell / cmd equivalents -- Claude uses a PowerShell tool on Windows.
  /\b(remove-item|rm|ri|del|erase|rd|rmdir)\b.*(-recurse|\/s\b)/i
]

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

function isLikelyDestructive(toolName: string, input: unknown): boolean {
  if (!SHELL_TOOLS.has(toolName)) return false
  const command = (input as { command?: string })?.command ?? ''
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))
}

/** An SDK message that says the plan limit was hit (an assistant error, or a 429 result). */
function isLimitMessage(message: unknown): boolean {
  const m = message as { type?: string; error?: string; is_error?: boolean; api_error_status?: number | null }
  if (m.type === 'assistant') return m.error === 'rate_limit'
  if (m.type === 'result') return m.is_error === true && m.api_error_status === 429
  return false
}

const sessions = new Map<string, ClaudeSession>()

export function getOrCreateSession(
  projectId: string,
  projectPath: string,
  resumeSessionId?: string,
  initialGoNutz = false
): ClaudeSession {
  const existing = sessions.get(projectId)
  if (existing && !existing.isDead()) return existing
  if (existing) {
    resumeSessionId = existing.getCapturedSessionId() ?? resumeSessionId
    initialGoNutz = existing.isGoNutzMode()
    existing.dispose()
  }
  const session = new ClaudeSession(projectId, projectPath, resumeSessionId, initialGoNutz)
  sessions.set(projectId, session)
  return session
}

/** Applies a model change to every open chat; new chats read it from settings. */
export async function setModelForAllSessions(model: string | null): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => s.setModel(model).catch(() => undefined)))
}

export function refreshExtensionsForAllSessions(): void {
  for (const s of sessions.values()) s.refreshExtensions()
}

export function getSession(projectId: string): ClaudeSession | undefined {
  return sessions.get(projectId)
}

export function disposeSession(projectId: string): void {
  sessions.get(projectId)?.dispose()
  sessions.delete(projectId)
}
