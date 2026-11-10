import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DelegationActivity } from '@shared/types'
import { decideToolCall, type ClinePolicy } from '../cline/hookPolicy'
import {
  clineDataDir,
  clineEnv,
  clineFailure,
  countsFromClineResult,
  describeClineActivity,
  markUnavailable,
  prepareClineHome,
  resolveClineLaunch,
  writeMcpSettings,
  type ClineRunArgs,
  type ClineRunResult
} from './clineExec'
import { killTree, trackChild } from './codexExec'

// Cline hosted the way editors host it (Zed, JetBrains, Neovim): `cline --acp` keeps
// running and VibeApp talks to it over the Agent Client Protocol (JSON-RPC on stdio).
// Found in the trial on cline 3.0.74 (2026-11-10, see ROADMAP):
// - It starts in about a second; a later hand-off in the same session starts at once
//   and keeps the conversation (a one-off CLI run starts cold every time).
// - Every step comes to VibeApp as a permission request with its full input, after
//   VibeApp's own hook (CLINE_DIR, as for the CLI) has made its swaps. So there are two
//   checks: the hook (it explains a refusal to Cline) and the answer here.
// - With no provider set it ran on pay-as-you-go "Cline Usage-Billing", not ClinePass:
//   CLINE_PROVIDER is pinned, and nothing is sent unless the session's model is ClinePass.
// - Usage isn't in the protocol; Cline keeps running totals in its session file.
// - Tool servers passed in session/new are ignored; the MCP settings file still works.

/** A hosted Cline that hasn't been used for this long is shut down. */
const IDLE_MS = 10 * 60_000
/** How long a cancelled prompt may take to wind down before the process is ended. */
const CANCEL_GRACE_MS = 5_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

interface ToolSeen {
  name: string
  input: Record<string, unknown>
}

interface Agent {
  key: string
  child: ChildProcessWithoutNullStreams
  temp: string
  hookLog: string
  policy: ClinePolicy
  nextId: number
  pending: Map<number, Pending>
  /** Session key (one request's hand-offs) -> Cline's session id. */
  sessions: Map<string, string>
  /** Cline's session id -> what's listening to its updates (the prompt running in it). */
  listeners: Map<string, (update: AcpUpdate) => void>
  /** Steps refused by the answer here during the current prompt. */
  refused: string[]
  busy: boolean
  dead: boolean
  stderr: string
  /** Said with each prompt when the memory tools couldn't be set up. */
  memoryNote: string
  idle?: NodeJS.Timeout
}

interface AcpUpdate {
  sessionUpdate: string
  content?: { type?: string; text?: string }
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
  rawInput?: Record<string, unknown>
  rawOutput?: unknown
}

const agents = new Map<string, Agent>()

/** The tool's own name from an ACP title ("run_commands: git status" -> run_commands). */
export function acpToolName(title: string | undefined): string {
  return (title ?? '').split(':')[0].trim()
}

/** How VibeApp answers a permission request: the same rules as the hook. */
export function permissionAnswer(policy: ClinePolicy, title: string | undefined, rawInput: unknown): { allow: boolean; reason?: string } {
  const decision = decideToolCall(policy, { name: acpToolName(title), input: rawInput })
  if (decision.allow) return { allow: true }
  // The hook swaps a refused command for an echo saying why (it runs first, so this is
  // normally already the echo); letting the swapped call through keeps Cline informed.
  if ('overrideInput' in decision) return { allow: true }
  return { allow: false, reason: decision.reason }
}

/** stopReason from session/prompt as VibeApp's finish reason. */
export function finishFromStop(stopReason: string | undefined): string {
  switch (stopReason) {
    case 'end_turn':
      return 'completed'
    case 'cancelled':
      return 'aborted'
    case 'max_tokens':
    case 'max_turn_requests':
      return 'max_iterations'
    default:
      return stopReason || 'error'
  }
}

function send(agent: Agent, message: object): void {
  if (agent.dead) return
  agent.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function request<T>(agent: Agent, method: string, params: object): Promise<T> {
  if (agent.dead) return Promise.reject(new Error('Cline has stopped.'))
  const id = agent.nextId++
  return new Promise<T>((resolve, reject) => {
    agent.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    send(agent, { id, method, params })
  })
}

function shutDown(agent: Agent): void {
  if (agents.get(agent.key) === agent) agents.delete(agent.key)
  if (agent.idle) clearTimeout(agent.idle)
  if (!agent.dead) {
    agent.dead = true
    killTree(agent.child)
  }
  for (const p of agent.pending.values()) p.reject(new Error('Cline has stopped.'))
  agent.pending.clear()
  rmSync(agent.temp, { recursive: true, force: true })
}

/** Ends every hosted Cline (VibeApp is quitting, or the tests are done). */
export function stopHostedCline(): void {
  for (const agent of [...agents.values()]) shutDown(agent)
}

function onAgentRequest(agent: Agent, message: { id: number; method: string; params: Record<string, unknown> }): void {
  if (message.method === 'session/request_permission') {
    const toolCall = (message.params.toolCall ?? {}) as { title?: string; rawInput?: unknown }
    const options = (message.params.options ?? []) as { optionId: string; kind: string }[]
    const answer = permissionAnswer(agent.policy, toolCall.title, toolCall.rawInput)
    if (!answer.allow && answer.reason) agent.refused.push(answer.reason)
    const wanted = answer.allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
    const option = options.find((o) => o.kind === wanted[0]) ?? options.find((o) => wanted.includes(o.kind))
    send(agent, {
      id: message.id,
      result: option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }
    })
    return
  }
  // VibeApp offers no file or terminal services: Cline does its own (behind the hook).
  send(agent, { id: message.id, error: { code: -32601, message: `VibeApp doesn't handle ${message.method}.` } })
}

async function startAgent(key: string, args: ClineRunArgs): Promise<Agent> {
  const launch = await resolveClineLaunch()
  if (!launch) throw new Error("Cline isn't installed.")
  const home = await prepareClineHome()
  const temp = mkdtempSync(join(tmpdir(), 'vibeapp-cline-acp-'))
  const hookLog = join(temp, 'blocked.jsonl')
  const policy: ClinePolicy = { mode: args.mode, projectPath: args.cwd, goNutz: !!args.goNutz, blockedNote: home.blockedNote, readFiles: [home.blockedNote] }
  const mcpPath = join(temp, 'mcp.json')
  const memoryNote = writeMcpSettings(mcpPath, home, args.memory)
  if (decideToolCall(policy, { name: 'composio_search_tools' }).allow) throw new Error("VibeApp's Cline policy check failed.")
  const env: NodeJS.ProcessEnv = {
    ...clineEnv(launch, home, args.mode, mcpPath, policy, hookLog),
    // ClinePass, never pay-as-you-go: unset, ACP sessions start on "Cline Usage-Billing".
    CLINE_PROVIDER: 'cline-pass',
    ...(args.model ? { CLINE_MODEL: args.model } : {})
  }
  const child = trackChild(
    spawn(launch.file, [...launch.prefixArgs, '--acp'], { windowsHide: true, env, cwd: args.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  )
  const agent: Agent = {
    key,
    child,
    temp,
    hookLog,
    policy,
    nextId: 1,
    pending: new Map(),
    sessions: new Map(),
    listeners: new Map(),
    refused: [],
    busy: false,
    dead: false,
    stderr: '',
    memoryNote
  }
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (!line) continue
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.method && message.id !== undefined) {
        onAgentRequest(agent, message as { id: number; method: string; params: Record<string, unknown> })
      } else if (message.id !== undefined) {
        const waiting = agent.pending.get(message.id)
        agent.pending.delete(message.id)
        if (message.error) waiting?.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
        else waiting?.resolve(message.result)
      } else if (message.method === 'session/update') {
        const params = message.params as { sessionId: string; update: AcpUpdate }
        agent.listeners.get(params.sessionId)?.(params.update)
      }
    }
  })
  child.stderr.on('data', (chunk: Buffer) => (agent.stderr = (agent.stderr + chunk.toString('utf8')).slice(-4000)))
  child.on('exit', () => {
    agent.dead = true
    shutDown(agent)
  })
  child.on('error', () => shutDown(agent))
  agents.set(key, agent)
  try {
    await request(agent, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'VibeApp', version: '1' } })
  } catch (err) {
    shutDown(agent)
    throw err
  }
  return agent
}

interface SessionTotals {
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }
  model?: string
}

/** Cline's running totals for a session, from its session file (the protocol doesn't carry them). */
function sessionTotals(sessionId: string): SessionTotals {
  try {
    const file = join(clineDataDir(), 'sessions', sessionId, `${sessionId}.json`)
    const data = JSON.parse(readFileSync(file, 'utf8')) as { model?: string; metadata?: { aggregateUsage?: SessionTotals['usage']; usage?: SessionTotals['usage'] } }
    return { usage: data.metadata?.aggregateUsage ?? data.metadata?.usage ?? {}, model: data.model }
  } catch {
    return { usage: {} }
  }
}

function hookLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { reason: string }).reason)
  } catch {
    return []
  }
}

/**
 * Runs a building job on a hosted Cline. Returns null when the hosted Cline can't be
 * used (not started, not on ClinePass, busy), so the caller runs the CLI instead;
 * never throws for Cline's own failures.
 */
export async function runClineHosted(args: ClineRunArgs, onActivity?: (activity: DelegationActivity) => void): Promise<ClineRunResult | null> {
  const key = JSON.stringify([args.mode, args.cwd.toLowerCase(), !!args.goNutz, args.memory?.projectId ?? null, args.model ?? null])
  let agent = agents.get(key)
  if (agent?.busy) return null
  try {
    agent = agent && !agent.dead ? agent : await startAgent(key, args)
  } catch (err) {
    console.warn('Hosted Cline unavailable, using a one-off run:', (err as Error).message)
    return null
  }
  if (agent.idle) clearTimeout(agent.idle)
  agent.busy = true
  agent.refused = []
  const running = agent

  try {
    // One conversation per session key (a request's hand-offs), checked to be on ClinePass.
    let sessionId = args.session ? running.sessions.get(args.session) : undefined
    if (!sessionId) {
      const created = await request<{ sessionId: string; models?: { currentModelId?: string } }>(running, 'session/new', { cwd: args.cwd, mcpServers: [] })
      const model = created.models?.currentModelId ?? ''
      if (!/^cline-pass\//.test(model)) {
        console.warn(`Hosted Cline isn't on ClinePass (${model || 'no model'}); using a one-off run.`)
        shutDown(running)
        return null
      }
      sessionId = created.sessionId
      if (args.session) running.sessions.set(args.session, sessionId)
    }
    const id = sessionId

    const before = sessionTotals(id)
    const hookBefore = hookLines(running.hookLog).length
    const tools = new Map<string, ToolSeen>()
    let toolCalls = 0
    let saying = ''
    let finalText = ''
    const sayNow = (): void => {
      const text = saying.trim()
      saying = ''
      if (!text) return
      const activity = describeClineActivity({ type: 'agent_event', event: { type: 'content_end', contentType: 'text', text } })
      if (activity) onActivity?.(activity)
    }
    running.listeners.set(id, (u) => {
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
        saying += u.content.text ?? ''
        finalText += u.content.text ?? ''
      } else if (u.sessionUpdate === 'tool_call' && u.toolCallId) {
        sayNow()
        finalText = '' // the report is what it says after its last step
        toolCalls++
        const seen = { name: acpToolName(u.title), input: (u.rawInput ?? {}) as Record<string, unknown> }
        tools.set(u.toolCallId, seen)
        const activity = describeClineActivity({ type: 'agent_event', event: { type: 'content_start', contentType: 'tool', toolName: seen.name, toolCallId: u.toolCallId, input: seen.input } })
        if (activity) onActivity?.(activity)
      } else if (u.sessionUpdate === 'tool_call_update' && u.toolCallId && (u.status === 'completed' || u.status === 'failed')) {
        const seen = tools.get(u.toolCallId)
        if (!seen) return
        const output = u.status === 'failed' && !u.rawOutput ? [{ result: 'Not allowed.', success: false }] : u.rawOutput
        const activity = describeClineActivity({ type: 'agent_event', event: { type: 'content_end', contentType: 'tool', toolName: seen.name, toolCallId: u.toolCallId, input: seen.input, output } })
        if (activity) onActivity?.(activity)
      }
    })

    // Stop and the time limit: ask Cline to cancel, and end the process if it doesn't.
    let stoppedBy: string | undefined
    let forced: NodeJS.Timeout | undefined
    const cancel = (why: string): void => {
      if (stoppedBy) return
      stoppedBy = why
      send(running, { method: 'session/cancel', params: { sessionId: id } })
      forced = setTimeout(() => shutDown(running), CANCEL_GRACE_MS)
    }
    const onAbort = (): void => cancel('Cline run was cancelled')
    if (args.signal?.aborted) onAbort()
    args.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = args.timeoutMs ? setTimeout(() => cancel(`Cline timed out after ${Math.round(args.timeoutMs! / 60_000)} minutes`), args.timeoutMs) : undefined

    let stopReason: string | undefined
    let failure: string | undefined
    try {
      const result = await request<{ stopReason?: string }>(running, 'session/prompt', { sessionId: id, prompt: [{ type: 'text', text: args.prompt + running.memoryNote }] })
      stopReason = result?.stopReason
    } catch (err) {
      failure = (err as Error).message
    } finally {
      if (timer) clearTimeout(timer)
      if (forced) clearTimeout(forced)
      args.signal?.removeEventListener('abort', onAbort)
      running.listeners.delete(id)
      sayNow()
    }

    const after = sessionTotals(id)
    const delta = (k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens'): number => Math.max(0, (after.usage[k] ?? 0) - (before.usage[k] ?? 0))
    const usage = countsFromClineResult({
      usage: { inputTokens: delta('inputTokens'), outputTokens: delta('outputTokens'), cacheReadTokens: delta('cacheReadTokens') },
      iterations: toolCalls + 1,
      model: after.model ? { id: after.model } : undefined
    })
    const blocked = [...hookLines(running.hookLog).slice(hookBefore), ...running.refused]
    const text = (finalText || '').trim()
    const base = { text, usage, model: after.model, blocked }

    if (stoppedBy) {
      return { ...base, finishReason: 'aborted', ok: false, error: stoppedBy }
    }
    if (failure) {
      const error = running.dead && !failure.trim() ? 'Cline stopped unexpectedly.' : clineFailure(failure)
      if (/no access to clinepass/i.test(failure)) markUnavailable(error, 10 * 60_000)
      else if (/limit reached/i.test(failure)) markUnavailable(error, 30 * 60_000)
      return { ...base, finishReason: 'error', ok: false, error }
    }
    const finishReason = finishFromStop(stopReason)
    if (finishReason === 'completed') return { ...base, finishReason, ok: true }
    const error = finishReason === 'aborted' && blocked.length ? `VibeApp stopped Cline: ${blocked[blocked.length - 1]}` : `Cline stopped (${stopReason ?? 'no reason given'}).`
    return { ...base, finishReason, ok: false, error }
  } catch (err) {
    // The session couldn't start: the one-off run gets a go.
    console.warn('Hosted Cline failed before its prompt; using a one-off run:', (err as Error).message)
    shutDown(running)
    return null
  } finally {
    running.busy = false
    if (!running.dead) {
      running.idle = setTimeout(() => shutDown(running), IDLE_MS)
      running.idle.unref()
    }
  }
}

/** How many hosted Clines are running (for tests). */
export function hostedClineCount(): number {
  return [...agents.values()].filter((a) => !a.dead).length
}
