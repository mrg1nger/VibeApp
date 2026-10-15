import type { DelegationActivity } from '@shared/types'
import { SECRET_PATTERNS } from '@shared/secretPatterns'

// Turns Codex's raw JSON events into steps a person can follow.

const SAY_CHARS = 1200
const OUTPUT_CHARS = 600
const OUTPUT_LINES = 8
const COMMAND_CHARS = 180

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

/** Hides anything that looks like a secret key before text is shown or saved. */
export function scrubSecrets(text: string): string {
  let out = text
  for (const { pattern } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, 'g'), '[hidden]')
  }
  return out
}

function unquote(text: string): string {
  const t = text.trim()
  const quote = t[0]
  if ((quote === "'" || quote === '"') && t.endsWith(quote) && t.length >= 2) return t.slice(1, -1)
  return t
}

/**
 * The command a person would recognise, without the shell wrapper Codex
 * runs it in: `"C:\...\powershell.exe" -Command 'npm test'` -> `npm test`.
 */
export function shortCommand(command: string): string {
  return commandParts(command).text
}

/** Splits at ; && || outside quotes. */
function statements(text: string): string[] {
  const out: string[] = []
  let current = ''
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = ''
      current += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
    } else if (ch === ';' || (ch === '&' && text[i + 1] === '&') || (ch === '|' && text[i + 1] === '|')) {
      if (ch !== ';') i++
      if (current.trim()) out.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

/**
 * `text` is the first statement (what the step is for); `full` is the whole
 * command, for hovering. Codex often chains housekeeping after the real
 * command (exit-code captures, git status).
 */
export function commandParts(command: string): { text: string; full: string } {
  let text = command.trim()
  for (let pass = 0; pass < 3; pass++) {
    const ps =
      /^"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+(?:\s+(?!-)\S+)?\s+)*?-Command\s+([\s\S]+)$/i.exec(text) ??
      /^"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+-c\s+([\s\S]+)$/i.exec(text)
    if (ps) {
      text = unquote(ps[1])
      continue
    }
    const cmd = /^"?[^"]*?cmd(?:\.exe)?"?\s+(?:\/[a-z]\s+)+([\s\S]+)$/i.exec(text)
    if (cmd) {
      text = unquote(cmd[1])
      continue
    }
    const sh = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(text)
    if (sh) {
      text = unquote(sh[1])
      continue
    }
    break
  }
  const flat = text.replace(/\s+/g, ' ').trim()
  const parts = statements(flat)
  const first = parts[0] ?? flat
  const short = `${first.length > COMMAND_CHARS ? `${first.slice(0, COMMAND_CHARS - 1)}…` : first}${parts.length > 1 ? ' …' : ''}`
  return { text: short, full: flat.slice(0, 800) }
}

function tidyOutput(output: string): string {
  const lines = output
    .replace(ANSI, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  while (lines.length && !lines[0]) lines.shift()
  let text = lines.slice(0, OUTPUT_LINES).join('\n')
  if (lines.length > OUTPUT_LINES) text += `\n… (${lines.length - OUTPUT_LINES} more lines)`
  if (text.length > OUTPUT_CHARS) text = `${text.slice(0, OUTPUT_CHARS)}…`
  return text
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

interface RawItem {
  id?: string
  type?: string
  text?: string
  command?: string
  aggregated_output?: string
  exit_code?: number | null
  status?: string
  changes?: { path: string; kind?: string }[]
  server?: string
  tool?: string
  name?: string
  prompt?: string | null
}

/** One readable step for a Codex JSON event, or null if the event isn't worth showing. */
export function describeActivity(event: { type: string; item?: unknown }): DelegationActivity | null {
  if (event.type !== 'item.started' && event.type !== 'item.completed') return null
  const item = event.item as RawItem | undefined
  if (!item?.type) return null
  const done = event.type === 'item.completed'
  const id = item.id ?? `${item.type}-${Math.random().toString(36).slice(2, 8)}`

  switch (item.type) {
    case 'agent_message': {
      if (!done || !item.text?.trim()) return null
      const text = scrubSecrets(item.text.trim())
      return { id, step: 'say', text: text.length > SAY_CHARS ? `${text.slice(0, SAY_CHARS)}…` : text, done: true }
    }
    case 'file_change': {
      const changes = item.changes ?? []
      if (!changes.length) return null
      const verb = (kind?: string): string => (kind === 'add' ? 'Created' : kind === 'delete' ? 'Deleted' : 'Edited')
      const kinds = new Set(changes.map((c) => verb(c.kind)))
      const names = changes.slice(0, 3).map((c) => fileName(c.path))
      const more = changes.length > 3 ? ` and ${changes.length - 3} more` : ''
      return {
        id,
        step: 'edit',
        text: `${[...kinds].join('/')} ${names.join(', ')}${more}`,
        done,
        ok: done ? item.status !== 'failed' : undefined
      }
    }
    case 'command_execution': {
      if (!item.command) return null
      const parts = commandParts(item.command)
      const text = scrubSecrets(parts.text)
      const full = parts.full !== parts.text ? scrubSecrets(parts.full) : undefined
      if (!done) return { id, step: 'run', text, full, done: false }
      const detail = tidyOutput(scrubSecrets(item.aggregated_output ?? ''))
      return {
        id,
        step: 'run',
        text,
        full,
        detail: detail || undefined,
        done: true,
        ok: item.exit_code === 0 || item.exit_code === null || item.exit_code === undefined
      }
    }
    case 'collab_tool_call': {
      // Codex's own helper agents (spawn / wait / send ...).
      const what = item.tool ?? 'working'
      const task = item.prompt?.trim() ? `: ${scrubSecrets(item.prompt.trim()).slice(0, 80)}` : ''
      return { id, step: 'tool', text: `Helper agent - ${what}${task}`, done, ok: done ? item.status !== 'failed' : undefined }
    }
    default: {
      // A tool call (for example, the shared memory tools).
      if (/mcp|tool/i.test(item.type)) {
        const name = [item.server, item.tool ?? item.name].filter(Boolean).join(': ')
        if (!name) return null
        return { id, step: 'tool', text: name, done, ok: done ? item.status !== 'failed' : undefined }
      }
      return null
    }
  }
}

/** The one-line status for the card header while a step runs. */
export function progressNote(activity: DelegationActivity): string | null {
  if (activity.done) return null
  if (activity.step === 'run') return `Running: ${activity.text}`
  if (activity.step === 'edit') return activity.text.replace(/^(\S+)/, (v) => `${v.replace(/ed$/, 'ing').replace(/^Created/, 'Creating')}`)
  if (activity.step === 'tool') return `Using ${activity.text}`
  return null
}
