import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveClaudeExecutable } from '../cli/claudeBinary'
import { codexFailure, runCodexExec } from '../cli/codexExec'
import { countsFromCodexEvents, countsFromSdkResult, type TokenCounts } from '../usage/tokens'

// Answering a question without building anything: one read-only call to
// Claude or Codex. No snapshots, no hand-offs, no review, no file changes.

export interface AskResult {
  text: string
  counts: TokenCounts
  /** Claude's session id, to continue the same conversation next time. */
  sessionId?: string
}

/** Claude rejected the request because the plan limit is used up. */
export class ClaudeLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeLimitError'
  }
}

export interface AskClaudeOptions {
  prompt: string
  /** Project folder, or a scratch folder for general chat. */
  cwd: string
  system: string
  /** Alias or model id; omitted means Claude Code's default. */
  model?: string
  abort: AbortController
  /** Let it read and search the project's files (never change them). */
  readFiles?: boolean
  /** Read-only access to VibeApp's shared memory for this project. */
  memory?: { scriptPath: string; dbPath: string; projectId: string; projectPath: string }
  resume?: string
}

/**
 * The memory tools a question may use: looking things up, plus the user's
 * to-do list and notes (keeping a list isn't changing the project).
 */
export const ASK_MEMORY_TOOLS = ['recall', 'history', 'handoffs', 'where', 'todos', 'add_todo', 'complete_todo', 'notes']
const MEMORY_TOOLS = ASK_MEMORY_TOOLS.map((t) => `mcp__vibe_memory__${t}`)

export async function askClaude(opts: AskClaudeOptions): Promise<AskResult> {
  const tools = opts.readFiles ? ['Read', 'Grep', 'Glob'] : []
  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      model: opts.model,
      systemPrompt: opts.system,
      tools,
      allowedTools: [...tools, ...(opts.memory ? MEMORY_TOOLS : [])],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: opts.memory
        ? {
            vibe_memory: {
              type: 'stdio' as const,
              command: process.execPath,
              args: [opts.memory.scriptPath, opts.memory.dbPath, opts.memory.projectId, 'claude', opts.memory.projectPath],
              env: { ELECTRON_RUN_AS_NODE: '1' },
              alwaysLoad: true
            }
          }
        : {},
      settings: { disableClaudeAiConnectors: true },
      maxTurns: 12,
      abortController: opts.abort,
      resume: opts.resume
    }
  })

  let sessionId: string | undefined
  let text = ''
  try {
    for await (const message of q) {
      if ('session_id' in message && message.session_id) sessionId = message.session_id
      if (message.type === 'assistant' && (message as { error?: string }).error === 'rate_limit') {
        throw new ClaudeLimitError("Claude's plan limit was reached.")
      }
      if (message.type !== 'result') continue
      const result = message as { is_error?: boolean; api_error_status?: number; result?: string; subtype?: string }
      if (result.is_error && result.api_error_status === 429) {
        throw new ClaudeLimitError(String(result.result ?? "Claude's plan limit was reached."))
      }
      if (result.is_error || result.subtype !== 'success') {
        throw new Error(String(result.result || `Claude couldn't answer (${result.subtype ?? 'error'}).`))
      }
      text = String(result.result ?? '')
      return { text, sessionId, counts: countsFromSdkResult(message as Parameters<typeof countsFromSdkResult>[0]) }
    }
  } catch (err) {
    if (err instanceof ClaudeLimitError) throw err
    // The SDK throws after a limit result; the message says so.
    if (/limit|429|rate/i.test((err as Error).message) && /hit your|session limit|usage limit|429/i.test((err as Error).message)) {
      throw new ClaudeLimitError((err as Error).message)
    }
    throw err
  }
  throw new Error('Claude finished without an answer.')
}

export interface AskCodexOptions {
  prompt: string
  cwd?: string
  model?: string
  effort?: string
  abort: AbortController
  /** The project's memory, for the to-do list and look-ups (files stay read-only). */
  memory?: { scriptPath: string; dbPath: string; projectId: string; projectPath: string }
}

export async function askCodex(opts: AskCodexOptions): Promise<AskResult> {
  const result = await runCodexExec({
    prompt: opts.prompt,
    cwd: opts.cwd ?? mkdtempSync(join(tmpdir(), 'vibeapp-chat-')),
    readOnly: true,
    ephemeral: true,
    model: opts.model,
    effort: opts.effort,
    readOnlyMemory: opts.memory ? { ...opts.memory, tools: ASK_MEMORY_TOOLS } : undefined,
    timeoutMs: 5 * 60_000,
    signal: opts.abort.signal
  })
  if (result.exitCode !== 0 && !result.finalMessage) throw new Error(codexFailure(result) ?? 'Codex could not answer that.')
  return {
    text: result.finalMessage || '(Codex returned no answer.)',
    counts: countsFromCodexEvents(result.events)
  }
}
