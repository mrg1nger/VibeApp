import { app } from 'electron'
import { execFile, spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { promisify } from 'util'
import type { DelegationActivity } from '@shared/types'
import { decideToolCall, type ClineMode, type ClinePolicy } from '../cline/hookPolicy'
import { commandParts, scrubSecrets } from './codexActivity'
import { killTree, trackChild } from './codexExec'
import type { TokenCounts } from '../usage/tokens'

// Runs the Cline CLI (a third coding agent, on the user's ClinePass plan) for
// VibeApp. Verified against cline 3.0.74 on Windows:
// - Cline approves every tool itself and has no sandbox. Each run gets
//   VibeApp's own Cline folder (CLINE_DIR) with a PreToolUse hook that
//   allows only what the run may do (hookPolicy.ts); the user's sign-in stays
//   in their own data folder (CLINE_DATA_DIR), so nothing of theirs changes.
// - --hooks-dir is accepted but ignored in this version; CLINE_DIR works.
// - Piped stdin isn't seen on Windows, so the prompt goes on the command line
//   (a long one goes in a file Cline reads first).
// - Without CLINE_SESSION_BACKEND_MODE=local a run may go to Cline's
//   background "hub" process, which doesn't get this run's settings.

const execFileAsync = promisify(execFile)

/**
 * Tools VibeApp never wants in its runs, switched off up front so Cline doesn't
 * reach for them (the hook refuses them anyway, but that stops the whole run).
 * The composio_* ones are the user's Cline account connectors (Gmail, Drive…):
 * found that when a tool it wanted wasn't there, Cline searched them first.
 */
const NEVER_TOOLS = [
  'ask_question',
  'fetch_web_content',
  'skills',
  'spawn_agent',
  'teams',
  'web_search',
  'composio_search_tools',
  'composio_multi_execute_tool',
  'composio_manage_connections',
  'composio_wait_for_connections',
  ...[
    'spawn_teammate', 'shutdown_teammate', 'status', 'task', 'run_task', 'cancel_run', 'list_runs', 'await_runs', 'send_message',
    'broadcast', 'read_mailbox', 'mission_log', 'cleanup', 'create_outcome', 'attach_outcome_fragment', 'review_outcome_fragment',
    'finalize_outcome', 'list_outcomes'
  ].map((t) => `team_${t}`)
]
const DISABLED_TOOLS: Record<ClineMode, string[]> = {
  build: NEVER_TOOLS,
  review: [...NEVER_TOOLS, 'editor', 'run_commands'],
  // A long prompt is a file the job reads; nothing else.
  helper: [...NEVER_TOOLS, 'editor', 'run_commands', 'search_codebase']
}

/** Past this, the prompt goes in a file (Windows caps a command line at 32,767 characters). */
const ARG_PROMPT_CHARS = 20_000

export interface ClineLaunch {
  file: string
  prefixArgs: string[]
  env: NodeJS.ProcessEnv
}

let cachedLaunch: ClineLaunch | null | undefined

/**
 * The compiled cline.exe inside an npm install (what the package's bin/cline
 * launcher runs), so no console window opens and no Node wrapper sits in
 * between. Falls back to the launcher run by this app's Node.
 */
export async function resolveClineLaunch(force = false): Promise<ClineLaunch | null> {
  if (!force && cachedLaunch !== undefined) return cachedLaunch
  if (process.env.VIBEAPP_CLINE_BIN && existsSync(process.env.VIBEAPP_CLINE_BIN)) {
    return (cachedLaunch = { file: process.env.VIBEAPP_CLINE_BIN, prefixArgs: [], env: {} })
  }
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('which', ['cline'], { timeout: 5_000 })
      return (cachedLaunch = stdout.trim() ? { file: stdout.trim(), prefixArgs: [], env: {} } : null)
    } catch {
      return (cachedLaunch = null)
    }
  }
  try {
    const { stdout } = await execFileAsync('where', ['cline'], { timeout: 5_000, windowsHide: true })
    const matches = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const exe = matches.find((m) => m.toLowerCase().endsWith('.exe'))
    if (exe) return (cachedLaunch = { file: exe, prefixArgs: [], env: {} })
    const shim = matches.find((m) => m.toLowerCase().endsWith('.cmd'))
    if (shim) {
      const root = join(dirname(shim), 'node_modules', 'cline')
      const wrapper = join(root, 'bin', 'cline')
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
      const native = [
        join(root, 'bin', '.cline'),
        join(root, 'node_modules', '@cline', `cli-windows-${arch}`, 'bin', 'cline.exe'),
        join(dirname(shim), 'node_modules', '@cline', `cli-windows-${arch}`, 'bin', 'cline.exe')
      ].find((p) => existsSync(p))
      // What the launcher passes on: lets Cline's own update check find its install.
      const env: NodeJS.ProcessEnv = existsSync(wrapper) ? { CLINE_WRAPPER_PATH: wrapper } : {}
      const certs = join(clineHome(), 'cli-node-extra-ca-certs.pem')
      if (existsSync(certs) && !process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = certs
      if (native) return (cachedLaunch = { file: native, prefixArgs: [], env })
      if (existsSync(wrapper)) return (cachedLaunch = { file: process.execPath, prefixArgs: [wrapper], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })
    }
  } catch {
    // not installed
  }
  return (cachedLaunch = null)
}

/** The user's own Cline folder (~/.cline unless they moved it). */
function clineHome(): string {
  return process.env.CLINE_DIR?.trim() || join(homedir(), '.cline')
}

/** Where the user's Cline keeps its sign-in and sessions. */
export function clineDataDir(): string {
  return process.env.CLINE_DATA_DIR?.trim() || join(clineHome(), 'data')
}

/** VibeApp's own Cline folder: its hook, settings and rules, nothing of the user's. */
export function vibeClineDir(): string {
  return join(app.getPath('userData'), 'cline')
}

let nodePath: string | null | undefined

/** The Node Cline runs the hook with: it calls "node", so its folder goes first on PATH. */
async function findNode(): Promise<string | null> {
  if (nodePath !== undefined) return nodePath
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', ['node'], { timeout: 5_000, windowsHide: true })
    nodePath = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l && (process.platform !== 'win32' || l.toLowerCase().endsWith('.exe'))) ?? null
  } catch {
    nodePath = null
  }
  return nodePath
}

function hookSourcePath(): string {
  // Emitted next to out/main/index.js by electron.vite.config.ts (inside app.asar when installed;
  // Electron's fs reads it from there, and it's copied out because Node can't).
  return join(__dirname, 'cline', 'clineHook.cjs')
}

interface PreparedHome {
  dir: string
  node: string
  blockedNote: string
  /** The memory server needs Node's built-in SQLite (Node 22.5+). */
  nodeHasSqlite: boolean
}

let prepared: { at: string; home: PreparedHome } | undefined

/**
 * Writes VibeApp's Cline folder (hook, per-mode settings) and checks the hook
 * really refuses things: Cline carries on unchecked if a hook fails, so a run
 * never starts without a hook that was just seen to work.
 */
export async function prepareClineHome(): Promise<PreparedHome> {
  const source = readFileSync(hookSourcePath(), 'utf8')
  const dir = vibeClineDir()
  if (prepared?.at === source.length + ':' + dir && existsSync(join(dir, 'hooks', 'PreToolUse.js'))) return prepared.home
  const node = await findNode()
  if (!node) throw new Error("Cline needs Node.js on this computer for VibeApp's safety checks, and none was found (\"node\" isn't on the PATH).")
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  writeFileSync(join(dir, 'hooks', 'PreToolUse.js'), source)
  const blockedNote = join(dir, 'blocked.txt')
  writeFileSync(
    blockedNote,
    'BLOCKED by VibeApp: reading that file is not allowed in this run (only files in the project are). Do not try another way round it; work with what you have and say in your report if something needs the user.\n'
  )
  // The user's telemetry choice carries over; Cline mustn't update itself in the middle of VibeApp's work.
  let telemetryOptOut = false
  try {
    telemetryOptOut = !!JSON.parse(readFileSync(join(clineDataDir(), 'settings', 'global-settings.json'), 'utf8')).telemetryOptOut
  } catch {
    // no settings of their own
  }
  for (const mode of Object.keys(DISABLED_TOOLS) as ClineMode[]) {
    writeFileSync(
      join(dir, `settings-${mode}.json`),
      // web_search is also switched off the per-tool way: the list alone left it on.
      JSON.stringify({ autoUpdateEnabled: false, telemetryOptOut, disabledTools: DISABLED_TOOLS[mode], tools: { web_search: { enabled: false } } }, null, 2)
    )
  }

  // The self-check: a refused command and an unknown tool, through the real hook and Node.
  const probe = (call: object, policy: ClinePolicy): Promise<string> =>
    new Promise((resolveOut, reject) => {
      const child = spawn(node, [join(dir, 'hooks', 'PreToolUse.js')], {
        windowsHide: true,
        env: { ...process.env, VIBEAPP_CLINE_POLICY: JSON.stringify(policy) }
      })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.on('error', reject)
      child.on('exit', () => resolveOut(out))
      child.stdin.end(JSON.stringify({ hookName: 'tool_call', tool_call: call }))
    })
  const policy: ClinePolicy = { mode: 'build', projectPath: dir }
  const refused = await probe({ name: 'run_commands', input: { commands: ['git push --force'] } }, policy)
  const unknown = await probe({ name: 'composio_search_tools', input: {} }, policy)
  if (!/BLOCKED by VibeApp/.test(refused) || !/"cancel":true/.test(unknown)) {
    throw new Error(`VibeApp's safety check for Cline didn't work (it answered ${JSON.stringify(refused.slice(0, 120))}), so Cline wasn't started.`)
  }
  let nodeHasSqlite = false
  try {
    await execFileAsync(node, ['--no-warnings', '-e', "require('node:sqlite')"], { timeout: 10_000, windowsHide: true })
    nodeHasSqlite = true
  } catch {
    // an older Node: Cline runs without the memory tools
  }
  const home = { dir, node, blockedNote, nodeHasSqlite }
  prepared = { at: source.length + ':' + dir, home }
  return home
}

// ---- availability ----

let unavailable: { reason: string; until: number } | undefined

/** Why Cline can't take work right now (not subscribed, limit reached), or undefined. */
export function clineUnavailable(): string | undefined {
  if (unavailable && Date.now() < unavailable.until) return unavailable.reason
  unavailable = undefined
  return undefined
}

function markUnavailable(reason: string, ms: number): void {
  unavailable = { reason, until: Date.now() + ms }
}

// ---- running ----

export interface ClineRunArgs {
  prompt: string
  mode: ClineMode
  /** The working folder: the project, or an empty folder for a background job. */
  cwd: string
  model?: string
  /** none | low | medium | high | xhigh */
  thinking?: string
  /** Replaces Cline's system prompt (background jobs). */
  system?: string
  goNutz?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  /** VibeApp's shared memory, as an MCP server for this run. */
  memory?: { scriptPath: string; dbPath: string; projectId: string; projectPath: string }
}

export interface ClineRunResult {
  /** Cline's final message. */
  text: string
  /** completed | aborted | error | max_iterations … ("aborted" also when VibeApp's hook stopped it). */
  finishReason: string
  ok: boolean
  usage: TokenCounts
  model?: string
  /** Why it failed, in plain words, when it did. */
  error?: string
  /** Tool calls the hook refused, in plain words. */
  blocked: string[]
}

interface ClineEvent {
  type: string
  message?: string
  hookEventName?: string
  event?: {
    type?: string
    contentType?: string
    text?: string
    toolName?: string
    toolCallId?: string
    input?: Record<string, unknown>
    output?: unknown
    error?: { message?: string }
  }
  finishReason?: string
  iterations?: number
  text?: string
  aggregateUsage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  usage?: ClineEvent['aggregateUsage']
  model?: { id?: string }
}

/** Token counts from Cline's run_result (its input count includes the cached part). */
export function countsFromClineResult(result: Pick<ClineEvent, 'aggregateUsage' | 'usage' | 'iterations' | 'model'>): TokenCounts {
  const u = result.aggregateUsage ?? result.usage ?? {}
  const cached = u.cacheReadTokens ?? 0
  return {
    fresh: Math.max(0, (u.inputTokens ?? 0) - cached),
    cached,
    output: u.outputTokens ?? 0,
    steps: Math.max(1, result.iterations ?? 1),
    model: result.model?.id
  }
}

/** Why a run failed, in plain words, from Cline's own error text. */
export function clineFailure(message: string): string {
  const m = message.trim()
  if (/no access to clinepass/i.test(m)) {
    return "Cline is signed in, but not to an account with ClinePass (it said: \"No access to ClinePass subscription models yet\"). In a terminal, run cline auth and sign in with the account that has ClinePass."
  }
  if (/clinepass limit reached|limit reached|rate limit|\b429\b/i.test(m)) {
    return `ClinePass's limit has been reached for now (Cline said: "${m.slice(0, 160)}").`
  }
  if (/not authenticated|unauthorized|\b401\b|sign in|log ?in/i.test(m)) {
    return 'Cline isn\'t signed in. In a terminal, run cline auth and choose ClinePass.'
  }
  return `Cline stopped with an error: ${m.slice(0, 400)}`
}

const SAY_CHARS = 1200

function fileName(path: unknown): string {
  return typeof path === 'string' ? (path.split(/[\\/]/).filter(Boolean).pop() ?? path) : 'a file'
}

function outputText(output: unknown): { text: string; ok: boolean } {
  const items = Array.isArray(output) ? output : output ? [output] : []
  const text = items.map((o) => (typeof o === 'object' && o && 'result' in o ? String((o as { result: unknown }).result ?? '') : '')).join('\n')
  const ok = items.every((o) => !(typeof o === 'object' && o && (o as { success?: boolean }).success === false))
  return { text, ok }
}

function tidy(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter((l, i, all) => l || (i > 0 && i < all.length - 1))
  let out = lines.slice(0, 8).join('\n')
  if (lines.length > 8) out += `\n… (${lines.length - 8} more lines)`
  return scrubSecrets(out.length > 600 ? `${out.slice(0, 600)}…` : out)
}

/** One readable step for a Cline JSON event, or null if it isn't worth showing. */
export function describeClineActivity(e: ClineEvent): DelegationActivity | null {
  if (e.type !== 'agent_event' || !e.event) return null
  const ev = e.event
  if (ev.type === 'content_end' && ev.contentType === 'text') {
    const text = scrubSecrets((ev.text ?? '').trim())
    if (!text) return null
    return { id: `say-${Math.random().toString(36).slice(2, 8)}`, step: 'say', text: text.length > SAY_CHARS ? `${text.slice(0, SAY_CHARS)}…` : text, done: true }
  }
  if (ev.contentType !== 'tool' || (ev.type !== 'content_start' && ev.type !== 'content_end')) return null
  const id = ev.toolCallId ?? `tool-${Math.random().toString(36).slice(2, 8)}`
  const done = ev.type === 'content_end'
  const name = ev.toolName ?? ''
  const input = ev.input ?? {}
  const result = done ? outputText(ev.output) : { text: '', ok: true }
  // A command the hook swapped for its explanation.
  const blocked = /BLOCKED by VibeApp/.test(result.text)
  switch (name) {
    case 'run_commands': {
      if (!done) {
        const first = Array.isArray(input.commands) ? String(input.commands[0] ?? '') : ''
        const parts = commandParts(first)
        return { id, step: 'run', text: scrubSecrets(parts.text), full: parts.full !== parts.text ? scrubSecrets(parts.full) : undefined, done: false }
      }
      const queries = Array.isArray(ev.output) ? (ev.output as { query?: string }[]).map((o) => o.query ?? '').filter(Boolean) : []
      const parts = commandParts(queries[0] ?? '')
      return {
        id,
        step: 'run',
        text: blocked ? 'Blocked by VibeApp: a command it may not run' : scrubSecrets(parts.text || 'Ran commands'),
        detail: tidy(result.text) || undefined,
        done: true,
        ok: result.ok && !blocked
      }
    }
    case 'editor':
      return { id, step: 'edit', text: `${input.old_text === undefined ? 'Wrote' : 'Edited'} ${fileName(input.path)}`, done, ok: done ? result.ok : undefined }
    case 'read_files': {
      const files = Array.isArray(input.files) ? (input.files as { path?: string }[]).map((f) => fileName(f.path)) : []
      if (!done && !files.length) return null
      return { id, step: 'tool', text: files.length ? `Read ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}` : 'Read files', done, ok: done ? result.ok : undefined }
    }
    case 'search_codebase':
      return { id, step: 'tool', text: 'Searched the code', done, ok: done ? result.ok : undefined }
    default: {
      const memory = /^vibe_memory__(.+)$/.exec(name)
      const friendly = memory
        ? ({ recall: 'Searched memory', remember: 'Saved to memory', where: 'Looked up where code lives', todos: 'Checked your to-do list', history: 'Looked back through the chat', handoffs: 'Looked at earlier hand-offs' } as Record<string, string>)[memory[1]] ??
          `Memory: ${memory[1]}`
        : name
      return friendly ? { id, step: 'tool', text: friendly, done, ok: done ? result.ok : undefined } : null
    }
  }
}

/** Runs Cline once and returns its report. Never throws for Cline's own failures; they're in error. */
export async function runCline(args: ClineRunArgs, onActivity?: (activity: DelegationActivity) => void): Promise<ClineRunResult> {
  const fail = (error: string): ClineRunResult => ({ text: '', finishReason: 'error', ok: false, usage: { fresh: 0, cached: 0, output: 0, steps: 1 }, error, blocked: [] })
  const reason = clineUnavailable()
  if (reason) return fail(reason)
  const launch = await resolveClineLaunch()
  if (!launch) return fail("Cline isn't installed on this computer (in a terminal: npm i -g cline, then cline auth).")
  let home: PreparedHome
  try {
    home = await prepareClineHome()
  } catch (err) {
    return fail((err as Error).message)
  }

  const temp = mkdtempSync(join(tmpdir(), 'vibeapp-cline-'))
  const hookLog = join(temp, 'blocked.jsonl')
  const policy: ClinePolicy = { mode: args.mode, projectPath: args.cwd, goNutz: !!args.goNutz, blockedNote: home.blockedNote, readFiles: [home.blockedNote] }
  let prompt = args.prompt
  if (prompt.length > ARG_PROMPT_CHARS) {
    const taskFile = join(temp, 'task.md')
    writeFileSync(taskFile, prompt)
    policy.readFiles!.push(taskFile)
    prompt = `Your task is in the file ${taskFile}. Read the whole file with read_files first, then do exactly what it says.`
  }
  // The memory tools, through the same server Claude and Codex use. Cline starts tool servers
  // through a shell, which splits any path with a space in it (C:\Program Files\nodejs, a user
  // or project folder name), so the command line has none: the paths go in the environment.
  // The server is copied out of app.asar for the Node that runs it.
  const mcpPath = join(temp, 'mcp.json')
  let memoryNote = ''
  let memoryServer: object | undefined
  if (args.memory) {
    const script = join(home.dir, 'memoryServer.cjs')
    try {
      const source = readFileSync(args.memory.scriptPath)
      if (!existsSync(script) || !readFileSync(script).equals(source)) writeFileSync(script, source)
      if (!home.nodeHasSqlite) throw new Error('needs Node 22.5 or newer')
      memoryServer = {
        command: 'node',
        args: ['-e', 'require(process.env.VIBE_MEMORY_SCRIPT)'],
        env: {
          VIBE_MEMORY_SCRIPT: script,
          VIBE_MEMORY_ARGS: JSON.stringify([args.memory.dbPath, args.memory.projectId, 'cline', args.memory.projectPath])
        },
        disabled: false
      }
    } catch (err) {
      memoryNote = `\n\n(The shared memory tools aren't available in this run: ${(err as Error).message}.)`
    }
  }
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: memoryServer ? { vibe_memory: memoryServer } : {} }))
  prompt += memoryNote
  // A last check, here in VibeApp, that the policy itself refuses an unknown tool.
  if (decideToolCall(policy, { name: 'composio_search_tools' }).allow) return fail('VibeApp\'s Cline policy check failed, so Cline wasn\'t started.')

  const cliArgs = ['--json', '-c', args.cwd, '--compaction', 'agentic']
  if (args.mode === 'review') cliArgs.push('-p')
  if (args.model) cliArgs.push('-m', args.model)
  if (args.thinking) cliArgs.push('--thinking', args.thinking)
  if (args.system) cliArgs.push('-s', args.system)
  // Cline's own timeout too, so it ends cleanly before VibeApp has to stop it.
  if (args.timeoutMs) cliArgs.push('-t', String(Math.max(30, Math.round(args.timeoutMs / 1000) - 5)))
  cliArgs.push(prompt)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...launch.env,
    CLINE_DIR: home.dir,
    CLINE_DATA_DIR: clineDataDir(),
    CLINE_SESSION_BACKEND_MODE: 'local',
    CLINE_GLOBAL_SETTINGS_PATH: join(home.dir, `settings-${args.mode}.json`),
    CLINE_MCP_SETTINGS_PATH: mcpPath,
    VIBEAPP_CLINE_POLICY: JSON.stringify(policy),
    VIBEAPP_CLINE_HOOK_LOG: hookLog,
    PATH: `${dirname(home.node)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? process.env.Path ?? ''}`
  }
  delete env.Path
  // A run started from inside an Electron app must not make Cline's own Node behave like Electron.
  if (!launch.env.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE

  let final: ClineEvent | undefined
  let lastError = ''
  try {
    await new Promise<void>((resolveRun, reject) => {
      // No stdin: with an open input pipe Cline waits for more prompt to arrive on it (found: every run hung).
      const child = trackChild(
        spawn(launch.file, [...launch.prefixArgs, ...cliArgs], { windowsHide: true, env, cwd: args.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      )
      let buffer = ''
      let stderr = ''
      const timer = args.timeoutMs
        ? setTimeout(() => {
            killTree(child)
            reject(new Error(`Cline timed out after ${Math.round(args.timeoutMs! / 60_000)} minutes`))
          }, args.timeoutMs)
        : undefined
      const onAbort = (): void => {
        if (timer) clearTimeout(timer)
        killTree(child)
        reject(new Error('Cline run was cancelled'))
      }
      if (args.signal?.aborted) onAbort()
      args.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let event: ClineEvent
          try {
            event = JSON.parse(line) as ClineEvent
          } catch {
            continue
          }
          if (event.type === 'run_result') final = event
          if (event.type === 'error' && event.message) lastError = event.message
          if (event.type === 'agent_event' && event.event?.type === 'error') lastError = event.event.error?.message ?? lastError
          const activity = describeClineActivity(event)
          if (activity) onActivity?.(activity)
        }
      })
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      child.on('error', (err) => {
        if (timer) clearTimeout(timer)
        reject(err)
      })
      child.on('exit', () => {
        if (timer) clearTimeout(timer)
        args.signal?.removeEventListener('abort', onAbort)
        if (!final && !lastError) {
          // Errors before the run starts arrive as one JSON line on stderr.
          const line = stderr.split('\n').reverse().find((l) => l.includes('"message"'))
          try {
            lastError = (JSON.parse(line ?? '') as { message?: string }).message ?? stderr.trim().slice(0, 400)
          } catch {
            lastError = stderr.trim().slice(0, 400) || 'Cline ended without a result.'
          }
        }
        resolveRun()
      })
    })
  } catch (err) {
    const blocked = readBlocked(hookLog)
    rmSync(temp, { recursive: true, force: true })
    return { ...fail((err as Error).message), blocked }
  }

  const blocked = readBlocked(hookLog)
  rmSync(temp, { recursive: true, force: true })
  const finishReason = final?.finishReason ?? 'error'
  const text = (final?.text ?? '').trim()
  const usage = final ? countsFromClineResult(final) : { fresh: 0, cached: 0, output: 0, steps: 1 }
  if (finishReason === 'completed') return { text, finishReason, ok: true, usage, model: final?.model?.id, blocked }

  const message = lastError || (finishReason === 'error' ? text : '')
  let error: string
  if (finishReason === 'aborted' && blocked.length) {
    error = `VibeApp stopped Cline: ${blocked[blocked.length - 1]}`
  } else if (message) {
    error = clineFailure(message)
    if (/no access to clinepass/i.test(message)) markUnavailable(error, 10 * 60_000)
    else if (/limit reached/i.test(message)) markUnavailable(error, 30 * 60_000)
  } else {
    error = `Cline stopped (${finishReason}).`
  }
  return { text, finishReason, ok: false, usage, model: final?.model?.id, error, blocked }
}

function readBlocked(path: string): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { reason: string }).reason)
  } catch {
    return []
  }
}

/** Whether Cline is installed (and its version), and why it can't take work right now, if it can't. */
export async function clineStatus(): Promise<{ installed: boolean; version?: string; unavailable?: string }> {
  const launch = await resolveClineLaunch(true)
  if (!launch) return { installed: false }
  try {
    const { stdout } = await execFileAsync(launch.file, [...launch.prefixArgs, '--version'], {
      timeout: 20_000,
      windowsHide: true,
      env: { ...process.env, ...launch.env }
    })
    return { installed: true, version: stdout.trim().split(/\s+/).pop(), unavailable: clineUnavailable() }
  } catch {
    return { installed: true, unavailable: clineUnavailable() }
  }
}

/** A tiny run to check Cline is installed, signed in and answering. */
export async function checkCline(model?: string): Promise<{ ok: boolean; message: string; model?: string; seconds: number }> {
  const started = Date.now()
  const cwd = mkdtempSync(join(tmpdir(), 'vibeapp-cline-check-'))
  try {
    const result = await runCline({
      prompt: 'Reply with the single word READY.',
      mode: 'helper',
      cwd,
      model,
      thinking: 'none',
      system: 'You are a connection check. Reply with exactly the word asked for.',
      timeoutMs: 90_000
    })
    const seconds = Math.round((Date.now() - started) / 100) / 10
    if (!result.ok) return { ok: false, message: result.error ?? 'Cline didn\'t answer.', seconds }
    return { ok: true, message: `Cline answered in ${seconds} s${result.model ? ` (${result.model})` : ''}.`, model: result.model, seconds }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}
