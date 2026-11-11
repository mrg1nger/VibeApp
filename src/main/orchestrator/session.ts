import { EventEmitter } from 'events'
import { watch, type FSWatcher } from 'fs'
import { randomUUID } from 'crypto'
import {
  query,
  type SDKUserMessage,
  type HookCallback,
  type PreCompactHookInput,
  type PreToolUseHookInput,
  type SDKCompactBoundaryMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { ConfirmationRequest, QuestionAnswers, UserQuestion, VibeEvent } from '@shared/types'
import { mapSdkMessage } from './eventSchema'
import { createCodexDelegationServer } from '../delegation/codexTool'
import { memoryDb, memoryDbPath, memoryServerScriptPath } from '../memory/paths'
import { activeExtensions, extensionInstructions } from '../extensions/store'
import { installExtensionForAgent } from '../extensions/install'
import { buildSubagents } from './subagents'
import { staysInProject } from './commandScope'
import { planModeBlock } from './planGuard'
import { githubDanger, githubDenyReason } from './githubGuard'
import { CLAUDE_PLAN_LIMITS, PLAN_INSTRUCTIONS } from '@shared/plan'
import { briefBlock } from '../memory/brief'
import { keyFactsBlock } from '../memory/store'
import { resolveClaudeExecutable } from '../cli/claudeBinary'
import { getSettings } from '../settings/store'
import { agentSecretEnv, listSecrets } from '../secrets/vault'
import type { PreparedImage } from '../attachments/images'
import type { CodexThread, RequestContext } from '../delegation/codexTool'
import { countsFromSdkResult, recordUsage } from '../usage/tokens'

/** A compaction's outcome: conversation size (tokens) before and after. */
export interface CompactResult {
  before: number
  after: number
  trigger: 'manual' | 'auto'
  durationMs?: number
}

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
6. To find where something lives in the code, call mcp__vibe_memory__where first (a map of the source files, each with a one-line summary) instead of searching files yourself. To look up what the user said earlier, use mcp__vibe_memory__history; to see what Codex did in earlier hand-offs, use mcp__vibe_memory__handoffs; to read a plan the user approved (a fact names it as "plan #3"), use mcp__vibe_memory__plans.
7. To deploy, use mcp__vibe_tools__run_deploy first (the project's saved Deploy). Before any other operational job (publish, release, restart a service, restore or migrate data, run the tests), or a deploy with no saved Deploy, find out how it was done before: the project brief and key facts below, mcp__vibe_memory__recall (try "deploy" or "procedure") and mcp__vibe_memory__history. Follow the method that worked. Don't write a new script or invent steps when one exists; if you find nothing, say so before working it out.`

const APP_INSTRUCTIONS = `# Live preview
VibeApp shows the user a live preview of their project next to this chat. It starts the preview with \`npm run dev\` (or \`npm start\`) when package.json has that script, otherwise it serves index.html from the project root. For web projects, keep one of those working so the user can see the result, and have dev servers print their local URL. Don't start long-running dev servers yourself; VibeApp runs them.
Messages may start with bracketed notes from VibeApp (for example, an element the user pointed at in the preview, or remembered facts and files that look relevant to the request). Use them as context; they're not something the user typed. Notes from a search are hints: check them against the code before relying on them.
Codex is automatically given the user's original request, the key facts and recent hand-offs when you hand it a task, so a task only needs to say what to do, which files are involved, and what done looks like.
Helpers: you can start sub-agents (the Agent tool) for self-contained jobs so this long conversation isn't re-read for them. Use explorer (cheap, read-only) to find where something is or survey several files, reviewer after a large or risky change (name the files and any rules that apply), and test-runner when test output would be long. They don't see this conversation, so put everything they need in the task. Don't use one for something a single file read would answer.
VibeApp doesn't commit anything for the user, so the working tree usually holds uncommitted work from earlier requests (some done by Codex while you were unavailable). A whole-tree git diff or git status therefore shows much more than the current request changed. Judge what a request changed from hand-off results, which list their own files and diff, and don't try to untangle or revert earlier uncommitted work unless asked.
If the user wants a new tool for you and Codex ("add a tool that...", "make an MCP server for..."), build it as a small MCP server in the project, then call mcp__vibe_tools__install_extension so it's available everywhere. Don't edit .mcp.json for that: servers listed there are only seen by you in this project.
Schedules: when the user wants something to happen on a schedule or after each Deploy ("every morning…", "check the site every 15 minutes"), call mcp__vibe_tools__save_schedule (and list_schedules to see or change existing ones). VibeApp runs those itself. Claude Code's own scheduling (the schedule and loop skills, CronCreate, RemoteTrigger, ScheduleWakeup) doesn't work inside VibeApp: don't use it.
GitHub: VibeApp uploads the project to its GitHub copy itself (from Publish, after each request when that's on, or on a schedule) and brings in newer work from the user's other computer. Don't push, pull or merge with GitHub yourself unless the user asks. For a backup on a schedule, use save_schedule with the github_backup action.
Deploy: when the user asks to deploy or put it live (or a plan step deploys), call mcp__vibe_tools__run_deploy. VibeApp runs the project's saved, checked Deploy steps with no AI and tells you how it went, which costs far less than deploying step by step yourself. If the project has none yet, offer to write one with save_deploy_recipe.`

/** What Claude hears when Plan mode turns a tool call away. */
function planDenyReason(blocked: string, refused: boolean): string {
  if (refused) {
    return `Plan mode is on, so VibeApp didn't let this ${blocked}. The user chose to keep planning in this request: change nothing, and finish with the plan.`
  }
  return `Plan mode is on, so VibeApp didn't let this ${blocked}. While planning, only look (read, search, read-only commands) and write the plan. If this was only to look or check, skip it or make it a step in the plan. If the user's message needs it done now, call mcp__vibe_tools__leave_plan_mode once, saying what you want to do and why: VibeApp asks the user.`
}

/** Claude Code's own scheduling, which doesn't run inside VibeApp: VibeApp's schedules are the way. */
const OWN_SCHEDULING_TOOLS = new Set(['CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'ScheduleWakeup'])
function isOwnScheduling(toolName: string, input: unknown): boolean {
  if (OWN_SCHEDULING_TOOLS.has(toolName)) return true
  const skill = String((input as { skill?: string; command?: string })?.skill ?? (input as { command?: string })?.command ?? '')
  return toolName === 'Skill' && /^\/?(schedule|loop)\b/i.test(skill.trim())
}

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
  /** Plan mode is on for the next request. */
  private planning = false
  /** This request, the user chose "Keep planning": leave_plan_mode doesn't ask again. */
  private leavePlanRefused = false
  /** Set while a /compact turn runs; resolved when it ends. */
  private compaction: { resolve: (result: CompactResult | null) => void; result: CompactResult | null } | undefined
  /** Runs before Claude Code compacts on its own (near its limit), so what only the conversation knew is saved first. */
  beforeAutoCompact: (() => Promise<void>) | undefined
  /** Runs the project's saved Deploy for the run_deploy tool (set by the app). */
  deployRunner: (() => Promise<{ ok: boolean; text: string }>) | undefined

  /** The Codex session this request's hand-offs share (reset by each new request). */
  private codexThread: CodexThread | undefined
  /** Size of the conversation Claude last saw, in tokens (from its latest API call). */
  private lastContextTokens = 0
  private sizeUnknown = false

  setRequestContext(context: RequestContext | undefined): void {
    this.requestContext = context
    this.codexThread = undefined
    this.leavePlanRefused = false
  }

  /**
   * Claude's leave_plan_mode: one prompt with what and why. Allowed, the rest of
   * the request is a Build (Go Nutz's rules again if it's on); refused, Claude
   * carries on planning and isn't asked about it again this request.
   */
  private async askToLeavePlan(what: string, why: string): Promise<string> {
    if (!this.planning) return "Plan mode isn't on: go ahead."
    if (this.leavePlanRefused) return 'The user already chose to keep planning in this request. Change nothing; finish with the plan.'
    const approved = await this.requestConfirmation('leave_plan_mode', { what, why }, `Claude wants to leave Plan mode and build: ${what}`, { what, why })
    if (!approved) {
      this.leavePlanRefused = true
      return 'The user chose to keep planning. Change nothing: finish exploring and write the plan, with what you wanted to do as steps in it.'
    }
    await this.setPlanning(false)
    this.emit('event', { type: 'plan_left', what } satisfies VibeEvent)
    return 'The user allowed it: Plan mode is off and the rest of this request is a normal Build. Go ahead with what you described.'
  }

  contextTokens(): number {
    return this.lastContextTokens
  }

  /** True for a resumed conversation that hasn't replied yet in this run (its size reads as 0 but may be large). */
  contextSizeUnknown(): boolean {
    return this.sizeUnknown
  }

  /**
   * Moves the conversation into a brand-new Claude session, so it stops
   * re-reading a very long history on every step. Only between requests;
   * the caller carries the earlier conversation over as a summary.
   */
  /**
   * Shrinks the conversation in place: Claude Code summarises it (following
   * `instructions`) and carries on in the same session. Only between
   * requests. Resolves with the sizes before and after, or null if it
   * couldn't run.
   */
  compact(instructions: string): Promise<CompactResult | null> {
    if (this.dead || this.disposed || this.turnsInFlight > 0 || this.compaction) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.compaction = { resolve, result: null }
      this.turnsInFlight++
      this.emit('event', { type: 'compacting' } satisfies VibeEvent)
      this.queue.push(`/compact ${instructions}`)
    })
  }

  private endCompaction(): void {
    const running = this.compaction
    this.compaction = undefined
    running?.resolve(running.result)
  }

  rotate(summary?: string): boolean {
    if (this.dead || this.disposed || this.turnsInFlight > 0) return false
    const before = this.lastContextTokens
    const old = this.queue
    this.capturedSessionId = undefined
    this.lastContextTokens = 0
    this.sizeUnknown = false
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
    // A resumed conversation's size isn't known until its first reply.
    this.sizeUnknown = !!resumeSessionId
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
    const briefText = briefBlock(this.projectId)

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
      (step, status) => {
        const event: VibeEvent = { type: 'plan_progress', step, status }
        this.emit('event', event)
      },
      async (req) => {
        const result = await installExtensionForAgent(req, this.projectPath, ({ reason, input }) =>
          this.requestConfirmation('install_extension', input, reason)
        )
        if (result.ok) refreshExtensionsForAllSessions()
        return result
      },
      () => this.deployRunner?.() ?? Promise.resolve({ ok: false, text: 'Deploy is not available here.' }),
      (what, why) => this.askToLeavePlan(what, why)
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

      if (isOwnScheduling(toolInput.tool_name, toolInput.tool_input)) {
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              "Claude Code's own scheduling doesn't run inside VibeApp. Use mcp__vibe_tools__save_schedule instead: VibeApp runs it (the user checks the draft and turns it on)."
          }
        }
      }

      // Whatever the mode (Go Nutz too): the user's GitHub account isn't Claude's to wreck.
      if (SHELL_TOOLS.has(toolInput.tool_name)) {
        const danger = githubDanger(String((toolInput.tool_input as { command?: string })?.command ?? ''))
        if (danger) {
          return {
            continue: true,
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: githubDenyReason(danger) }
          }
        }
      }

      // Plan mode: only looking, whatever the mode (Go Nutz too). Claude Code's own plan
      // mode lets commands through, and VibeApp's tools are approved just below.
      if (this.planning) {
        const blocked = planModeBlock(toolInput.tool_name, toolInput.tool_input)
        if (blocked) {
          return {
            continue: true,
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: planDenyReason(blocked, this.leavePlanRefused) }
          }
        }
      }

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
          permissionDecisionReason: "The user clicked Deny for this in VibeApp's Allow/Deny prompt. It was their choice, not a setting: don't retry it, and if it's really needed, explain why in plain words and let them decide."
        }
      }
    }

    // Tools the user installed once for every project (Extensions screen).
    const extensions = activeExtensions()
    const extensionServers = Object.fromEntries(
      extensions.map((e) => [e.server, { type: 'stdio' as const, command: e.command, args: e.args, env: e.env }])
    )

    const beforeCompact: HookCallback = async (input) => {
      if (input.hook_event_name === 'PreCompact' && (input as PreCompactHookInput).trigger === 'auto') {
        try {
          await this.beforeAutoCompact?.()
        } catch (err) {
          console.warn('Saving memory before compaction failed:', (err as Error).message)
        }
      }
      return { continue: true }
    }

    const queue = new MessageQueue()
    this.activeModel = getSettings().claudeModel
    this.queryHandle = query({
      prompt: queue,
      options: {
        cwd: this.projectPath,
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        model: this.activeModel ?? undefined,
        // Replaces the inherited environment, so start from process.env.
        // Helper agents must finish inside the request: left to run in the
        // background they report back after VibeApp has already called the
        // turn done (and reviewed a half-finished change).
        env: { ...process.env, ...agentSecretEnv(this.projectId), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
        agents: buildSubagents(this.projectPath),
        permissionMode: this.planning ? 'plan' : goNutz ? 'bypassPermissions' : 'acceptEdits',
        // Always set so setPermissionMode('bypassPermissions') can be used
        // later to enter Go Nutz mode without recreating the session -- this
        // flag only takes effect once that mode is actually switched to.
        allowDangerouslySkipPermissions: true,
        resume: resumeSessionId,
        planModeInstructions: `${PLAN_INSTRUCTIONS}\n${CLAUDE_PLAN_LIMITS}`,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: `${memoryInstructions(getSettings().autoMemory)}\n\n## Key facts\n${keyFacts}${briefText ? `\n\n## Project brief (what a newcomer needs to know)\n${briefText}` : ''}\n\n${APP_INSTRUCTIONS}${secretsInstructions(this.projectId)}${extensionInstructions(extensions) ? `

${extensionInstructions(extensions)}` : ''}`
        },
        mcpServers: { ...extensionServers, vibe_tools: codexServer, vibe_memory: memoryServer },
        // Only called when Claude Code itself wants to ask (sensitive files
        // like .mcp.json, paths outside the project). With no handler those
        // requests were silently denied.
        canUseTool: async (toolName, input, options) => {
          // Plan mode: the plan is now on the user's screen as a card to approve, change or cancel
          // (see eventSchema). Letting the tool through would start building without that approval.
          if (toolName === 'ExitPlanMode') {
            return {
              behavior: 'deny',
              message:
                "VibeApp is showing this plan to the user to approve, change or cancel. End your turn now with one short line (for example \"Here's the plan.\") and do nothing else until they reply."
            }
          }
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
          // On Windows, Claude Code asks before every PowerShell command, so outside Go Nutz
          // mode even running the tests raised a prompt. Ordinary commands that stay in the
          // project go ahead; risky ones (caught earlier by the PreToolUse gate) and anything
          // reaching outside the project still ask.
          const command = (input as { command?: string }).command ?? ''
          if (
            SHELL_TOOLS.has(toolName) &&
            !isLikelyDestructive(toolName, input) &&
            staysInProject(command, this.projectPath)
          ) {
            return { behavior: 'allow', updatedInput: input }
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
            : { behavior: 'deny', message: "The user clicked Deny for this in VibeApp's Allow/Deny prompt. It was their choice, not a setting: don't retry it, and if it's really needed, explain why in plain words and let them decide." }
        },
        hooks: {
          PreToolUse: [{ hooks: [destructiveCommandGate] }],
          // VibeApp's own compactions save first; this covers Claude Code compacting by itself.
          PreCompact: [{ hooks: [beforeCompact], timeout: 120 }]
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
    if (!this.planning) await this.queryHandle.setPermissionMode(enabled ? 'bypassPermissions' : 'acceptEdits')
  }

  /** Plan mode: Claude may only look around and propose a plan. Off again for building (or Go Nutz). */
  async setPlanning(on: boolean): Promise<void> {
    if (this.dead || this.disposed || on === this.planning) return
    this.planning = on
    await this.queryHandle.setPermissionMode(on ? 'plan' : this.goNutz ? 'bypassPermissions' : 'acceptEdits')
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
            this.stopping = false
            if (this.compaction) this.endCompaction()
            else this.emit('event', { type: 'turn_complete' } satisfies VibeEvent)
          }
          continue
        }
        // The conversation was compacted (asked for, or by Claude Code itself near its limit).
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as unknown as SDKCompactBoundaryMessage).compact_metadata
          const result: CompactResult = {
            before: meta.pre_tokens,
            after: meta.post_tokens ?? 0,
            trigger: meta.trigger,
            durationMs: meta.duration_ms
          }
          if (meta.post_tokens) this.lastContextTokens = meta.post_tokens
          if (this.compaction) this.compaction.result = result
          // The SDK reports no usage for it; log an estimate (one read of the old context, one summary written).
          recordUsage(this.projectId, 'compact', 'claude', {
            fresh: 0,
            cached: meta.pre_tokens,
            output: meta.post_tokens ?? 0,
            steps: 1
          })
          this.emit('event', { type: 'session_compacted', ...result } satisfies VibeEvent)
          // Key facts and the project brief are part of Claude's instructions, which are set when a
          // session starts; restart it (keeping the compacted conversation) so what the save pass
          // just wrote is in front of Claude. Waits for the current turn to finish.
          this.requestReload(false)
          continue
        }
        // The end of a /compact turn: not a reply, so no usage line and no turn_complete.
        if (message.type === 'result' && this.compaction) {
          this.turnsInFlight = Math.max(0, this.turnsInFlight - 1)
          // Stop pressed during it: that's handled now, so the next reply isn't mistaken for a stopped one.
          this.stopping = false
          this.endCompaction()
          if (this.reloadPending && this.turnsInFlight === 0) this.reload()
          continue
        }
        // Helper agents' calls have their own small contexts; only the main conversation's count.
        if (message.type === 'assistant' && !(message as { parent_tool_use_id?: string | null }).parent_tool_use_id) {
          // Each API call reports how much it read: that's the conversation's size now.
          const u = (
            message.message as {
              usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
            }
          ).usage
          if (u) {
            this.lastContextTokens =
              (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
            this.sizeUnknown = false
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
    this.endCompaction()
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

  private requestConfirmation(toolName: string, input: unknown, reason: string, leavePlan?: ConfirmationRequest['leavePlan']): Promise<boolean> {
    return new Promise((resolve) => {
      const request: ConfirmationRequest = { id: randomUUID(), toolName, input, reason, ...(leavePlan ? { leavePlan } : {}) }
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
