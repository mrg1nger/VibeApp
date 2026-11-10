import type { VibeEvent } from '@shared/types'
import type { RequestLogRow } from '../memory/store'

// One row per Build/Plan request: what Claude spent its steps on and how much
// went to Codex, so "is the Claude/Codex split working?" can be answered from
// numbers instead of by reading chat logs.

/** What a tool call of Claude's was for. */
export type StepKind =
  | 'read' // reading and searching files, the code map
  | 'edit' // writing files itself
  | 'command' // local commands (tests, builds, git)
  | 'server' // commands on another machine (ssh, scp, rsync): usually deploying by hand
  | 'browser' // Playwright: checking the app in a browser
  | 'handoff' // giving work to Codex
  | 'cline' // giving work to Cline
  | 'deploy' // the saved Deploy (no AI)
  | 'progress' // ticking off plan steps
  | 'memory' // memory, history, to-dos
  | 'helper' // a helper sub-agent
  | 'other'

const SERVER_COMMAND = /\b(ssh|scp|rsync|sftp)\b/

export function stepKind(name: string, input?: unknown): StepKind {
  if (/run_codex_subtask$/.test(name)) return 'handoff'
  if (/run_cline_subtask$/.test(name)) return 'cline'
  if (/run_deploy$/.test(name)) return 'deploy'
  if (/plan_progress$/.test(name)) return 'progress'
  if (/playwright|browser_/i.test(name)) return 'browser'
  if (name === 'mcp__vibe_memory__where') return 'read'
  if (name.startsWith('mcp__vibe_memory__')) return 'memory'
  if (['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'].includes(name)) return 'read'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'edit'
  if (name === 'Agent' || name === 'Task') return 'helper'
  if (name === 'Bash' || name === 'PowerShell') {
    const command = String((input as { command?: string } | undefined)?.command ?? '')
    return SERVER_COMMAND.test(command) ? 'server' : 'command'
  }
  return 'other'
}

export interface RequestStart {
  projectId: string
  mode: 'build' | 'plan' | 'plan_build'
  text: string
  balance?: string | null
  route?: string | null
  size?: string | null
}

/** Collects one request's events; finish() gives its row (without Codex tokens, which come from the usage log). */
export class RequestRecorder {
  readonly startedAt = new Date()
  private tools: Record<string, number> = {}
  private handoffs = 0
  private claudeSteps = 0
  private claude = { fresh: 0, cached: 0, output: 0 }
  private model: string | null = null
  private outcome: 'done' | 'stopped' | 'error' = 'done'
  private takeover = false
  /** A plan request becomes a build when the user lets Claude leave Plan mode. */
  private mode: RequestStart['mode']

  constructor(readonly start: RequestStart) {
    this.mode = start.mode
  }

  /** Returns true once the request is over (turn_complete). */
  observe(event: VibeEvent): boolean {
    switch (event.type) {
      case 'tool_call': {
        // A helper's own steps are inside the helper's cost, not Claude's main conversation.
        if (event.parentToolUseId) break
        const kind = stepKind(event.name, event.input)
        this.tools[kind] = (this.tools[kind] ?? 0) + 1
        if (kind === 'handoff') this.handoffs++
        break
      }
      case 'usage':
        this.claudeSteps += event.steps
        this.claude.fresh += event.fresh
        this.claude.cached += event.cached
        this.claude.output += event.output
        if (event.model) this.model = event.model
        break
      case 'takeover_started':
        this.takeover = true
        break
      case 'plan_left':
        this.mode = 'build'
        break
      case 'stopped':
        this.outcome = 'stopped'
        break
      case 'error':
      case 'claude_limit':
        if (this.outcome === 'done') this.outcome = 'error'
        break
      case 'turn_complete':
        return true
    }
    return false
  }

  finish(
    codex: RequestLogRow['codex'] = { fresh: 0, cached: 0, output: 0 },
    cline: RequestLogRow['cline'] = { fresh: 0, cached: 0, output: 0 }
  ): RequestLogRow {
    return {
      at: this.startedAt.toISOString(),
      projectId: this.start.projectId,
      mode: this.takeover ? 'takeover' : this.mode,
      balance: this.start.balance ?? null,
      route: this.start.route ?? null,
      size: this.start.size ?? null,
      model: this.model,
      text: this.start.text,
      outcome: this.outcome,
      seconds: (Date.now() - this.startedAt.getTime()) / 1000,
      claudeSteps: this.claudeSteps,
      tools: { ...this.tools },
      handoffs: this.handoffs,
      claude: { ...this.claude },
      codex,
      cline
    }
  }
}
