// What Cline may do in a VibeApp run. Cline approves every tool by itself and
// has no sandbox, so VibeApp puts a PreToolUse hook in front of every tool
// call (hookMain.ts, run by Cline for each call) and this decides it.
//
// Found on a real install: Cline also offers the tools of the user's Cline
// account connectors (Gmail, Google Drive, Docs through Composio), and with
// its editor turned off it went looking for a Google Drive tool to edit a
// file with. So it's an allow-list: anything not named here is refused.

import { isAbsolute, relative, resolve } from 'path'
import { staysInProject } from '../orchestrator/commandScope'
import { githubDanger } from '../orchestrator/githubGuard'

export type ClineMode = 'build' | 'review' | 'helper'

export interface ClinePolicy {
  mode: ClineMode
  /** The project folder (the run's working folder). */
  projectPath: string
  /** Go Nutz: commands that reach outside the project are allowed (GitHub account changes still aren't). */
  goNutz?: boolean
  /** Files outside the project that may be read (the task file of a long prompt). */
  readFiles?: string[]
  /** A file whose text explains a refused read (read instead of the refused file). */
  blockedNote?: string
}

export interface ToolCall {
  name?: string
  input?: unknown
}

export type HookDecision =
  | { allow: true }
  /** Swap the tool's input for this one (a refused command becomes an echo that says why). */
  | { allow: false; reason: string; overrideInput: unknown }
  /** Stop the whole run: the tool can't be made harmless. */
  | { allow: false; reason: string; cancel: true }

/** Memory tools that only read. */
const MEMORY_READS = new Set(['recall', 'where', 'history', 'handoffs', 'todos', 'notes'])
/** Memory tools that change the shared memory (allowed when building). */
const MEMORY_WRITES = new Set(['remember', 'update', 'forget', 'add_todo', 'complete_todo'])

/** Commands that destroy work or history, refused outside Go Nutz. */
const DESTRUCTIVE: { pattern: RegExp; what: string }[] = [
  { pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*r/i, what: 'deleting folders with rm -r' },
  { pattern: /\b(Remove-Item|ri|rm|del|erase)\b[^\n;|&]*-Recurse\b/i, what: 'deleting folders with Remove-Item -Recurse' },
  { pattern: /\b(rd|rmdir|del|erase)\b[^\n;|&]*\/s\b/i, what: 'deleting folders with rmdir /s' },
  { pattern: /\bdrop\s+(table|database)\b/i, what: 'deleting a database table' },
  { pattern: /\bgit(?:\.exe)?\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+--\s+\.|restore\s+(--staged\s+)?\.)/i, what: 'throwing away changes with git' },
  { pattern: /\bgit(?:\.exe)?\s+push\b[^\n]*(\s-f\b|--force)/i, what: 'force-pushing with git' },
  { pattern: /\bgit(?:\.exe)?\s+push\b/i, what: 'pushing to GitHub (VibeApp does that through its own buttons)' },
  { pattern: /\bformat(-volume)?\b.*\b[a-z]:|\b(diskpart|mkfs(\.\w+)?)\b/i, what: 'formatting a disk' },
  { pattern: /\b(shutdown|Restart-Computer|Stop-Computer)\b/i, what: 'shutting the computer down' },
  { pattern: /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^\n]*\|\s*(sh|bash|iex|Invoke-Expression|powershell|pwsh)\b/i, what: 'running a script straight from the internet' },
  { pattern: /\b(reg(\.exe)?\s+(add|delete)|Set-ItemProperty\s+-Path\s+['"]?HK)/i, what: 'changing the Windows registry' }
]

function inside(path: string, folder: string): boolean {
  const rel = relative(resolve(folder), resolve(folder, path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Why a command isn't allowed in this run, or null. */
export function commandDanger(command: string, policy: ClinePolicy): string | null {
  const github = githubDanger(command)
  if (github) return github
  if (policy.goNutz) return null
  for (const rule of DESTRUCTIVE) if (rule.pattern.test(command)) return rule.what
  if (!staysInProject(command, policy.projectPath)) return 'working outside the project folder'
  return null
}

function commandText(command: unknown): string {
  return typeof command === 'string' ? command : JSON.stringify(command ?? '')
}

function blockedEcho(what: string): string {
  // Single quotes: the same in PowerShell and bash, and the message has none.
  return `echo 'BLOCKED by VibeApp: ${what.replace(/'/g, '')} is not allowed in this run. Do not try another way round it; say in your report that it needs the user.'`
}

export function decideToolCall(policy: ClinePolicy, call: ToolCall): HookDecision {
  const name = call.name ?? ''
  const input = (call.input ?? {}) as Record<string, unknown>
  const refuse = (reason: string): HookDecision => ({ allow: false, reason, cancel: true })

  // VibeApp's shared memory (its MCP server is named vibe_memory).
  const memory = /^vibe_memory__([a-z_]+)$/.exec(name)
  if (memory) {
    if (MEMORY_READS.has(memory[1]) && policy.mode !== 'helper') return { allow: true }
    if (MEMORY_WRITES.has(memory[1]) && policy.mode === 'build') return { allow: true }
    return refuse(`VibeApp doesn't allow the memory tool ${memory[1]} here.`)
  }

  switch (name) {
    case 'read_files': {
      const files = Array.isArray(input.files) ? (input.files as { path?: unknown }[]) : []
      const allowedExtra = new Set((policy.readFiles ?? []).map((f) => resolve(f).toLowerCase()))
      const ok = (path: unknown): boolean =>
        typeof path === 'string' &&
        (allowedExtra.has(resolve(policy.projectPath, path).toLowerCase()) ||
          (policy.mode !== 'helper' && inside(path, policy.projectPath)))
      if (files.length && files.every((f) => ok(f?.path))) return { allow: true }
      const reason = policy.mode === 'helper' ? 'This job has no tools.' : 'Reading files outside the project is not allowed.'
      if (!policy.blockedNote) return refuse(reason)
      // Read the explanation instead, so the run carries on.
      return { allow: false, reason, overrideInput: { ...input, files: [{ path: policy.blockedNote }] } }
    }
    case 'search_codebase':
      // Searches the run's working folder (the project).
      return policy.mode === 'helper' ? refuse('This job has no tools.') : { allow: true }
    case 'editor': {
      if (policy.mode !== 'build') return refuse('This run may not change files.')
      const path = input.path
      if (typeof path === 'string' && inside(path, policy.projectPath)) return { allow: true }
      return refuse('Changing files outside the project is not allowed.')
    }
    case 'run_commands': {
      if (policy.mode !== 'build') return refuse('This run may not run commands.')
      const commands = Array.isArray(input.commands) ? input.commands : [input.commands]
      const verdicts = commands.map((c) => commandDanger(commandText(c), policy))
      if (verdicts.every((v) => v === null)) return { allow: true }
      const reasons = verdicts.filter(Boolean) as string[]
      return {
        allow: false,
        reason: reasons.join('; '),
        overrideInput: { ...input, commands: commands.map((c, i) => (verdicts[i] ? blockedEcho(verdicts[i]!) : c)) }
      }
    }
    default:
      // Connectors (Gmail, Drive…), web fetches, helper agents, questions to a user who isn't there.
      return refuse(`VibeApp doesn't allow the ${name || 'unnamed'} tool in Cline runs.`)
  }
}

/** The hook's answer to Cline, from a decision (Cline's PreToolUse output format). */
export function hookOutput(decision: HookDecision): Record<string, unknown> {
  if (decision.allow) return {}
  if ('cancel' in decision) return { cancel: true, errorMessage: decision.reason }
  return { overrideInput: decision.overrideInput }
}
