import type { RequestLogRow } from '../memory/store'
import type { StepKind } from './requestLog'

// A plain-text usage report: where Claude's plan went (by project, by kind of
// work, by request) and how the work was split with Codex. Read by people in
// Settings and by Claude Code through the API, so it's compact and labelled.

/**
 * A rough weight for plan usage, in "fresh Sonnet input token" units: a cached
 * read costs about a tenth of fresh input and output about five times as much
 * (API price ratios; plan limits aren't published), Haiku about a third of
 * Sonnet and Opus about five thirds. An estimate for comparing, not a bill.
 */
export function weight(t: { fresh: number; cached: number; output: number }, model?: string | null): number {
  const factor = /haiku/i.test(model ?? '') ? 1 / 3 : /opus/i.test(model ?? '') ? 5 / 3 : 1
  return (t.fresh + t.cached * 0.1 + t.output * 5) * factor
}

/** Helpers that always run on Haiku when the log has no model for them. */
const HAIKU_KINDS = new Set(['route', 'scribe', 'tidy', 'brief', 'codemap', 'summary'])

export interface UsageRow {
  projectId: string
  agent: string
  kind: string
  model: string | null
  runs: number
  fresh: number
  cached: number
  output: number
}

const STEP_LABELS: Record<StepKind, string> = {
  read: 'reading/searching',
  edit: 'editing files itself',
  command: 'local commands',
  server: 'server commands (ssh/scp)',
  browser: 'browser checks',
  handoff: 'hand-offs to Codex',
  cline: 'hand-offs to Cline',
  deploy: 'saved Deploy',
  progress: 'plan ticks',
  memory: 'memory',
  helper: 'helpers',
  other: 'other'
}

const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-')
const k = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)))
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

/** Claude's tool calls by kind, as "40% browser checks, 20% ...", biggest first. */
export function stepMix(tools: Record<string, number>, top = 5): string {
  const total = sum(Object.values(tools))
  if (!total) return 'no tool calls'
  return Object.entries(tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([kind, n]) => `${pct(n, total)} ${STEP_LABELS[kind as StepKind] ?? kind}`)
    .join(', ')
}

function addTools(into: Record<string, number>, tools: Record<string, number>): void {
  for (const [kind, n] of Object.entries(tools)) into[kind] = (into[kind] ?? 0) + n
}

const MODE_LABELS: Record<string, string> = {
  build: 'Build requests',
  plan: 'Making a plan',
  plan_build: 'Building an approved plan',
  takeover: 'Codex alone (Claude out)'
}

export function buildReport(input: {
  days: number
  usage: UsageRow[]
  requests: RequestLogRow[]
  projectNames: Map<string, string>
  /** Plan windows right now, e.g. "Claude weekly 44% used". */
  plans?: string[]
  /** Only this project (its name), when the report was filtered. */
  only?: string
}): string {
  const { days, usage, requests, projectNames } = input
  const name = (id: string): string => (id ? projectNames.get(id) ?? id : '(no project: Chat tab)')
  const lines: string[] = [
    `VibeApp usage, last ${days} day${days === 1 ? '' : 's'}${input.only ? ` (${input.only} only)` : ''}`,
    'Weights are estimates in fresh-Sonnet-input units (cached reads x0.1, output x5, Haiku /3, Opus x5/3).'
  ]
  if (input.plans?.length) lines.push(`Plans now: ${input.plans.join(' · ')}`)

  // ---- Claude by project and by kind of work
  const claudeRows = usage.filter((u) => u.agent === 'claude')
  const w = (u: UsageRow): number => weight(u, u.model ?? (HAIKU_KINDS.has(u.kind) ? 'haiku' : null))
  const claudeTotal = sum(claudeRows.map(w))
  const byProject = new Map<string, number>()
  const byKind = new Map<string, { weight: number; runs: number }>()
  for (const u of claudeRows) {
    byProject.set(u.projectId, (byProject.get(u.projectId) ?? 0) + w(u))
    const kind = byKind.get(u.kind) ?? { weight: 0, runs: 0 }
    kind.weight += w(u)
    kind.runs += u.runs
    byKind.set(u.kind, kind)
  }
  lines.push('', `## Claude, by project (total ${k(claudeTotal)})`)
  for (const [id, wt] of [...byProject].sort((a, b) => b[1] - a[1])) lines.push(`- ${name(id)}: ${pct(wt, claudeTotal)} (${k(wt)})`)
  lines.push('', '## Claude, by kind of work')
  for (const [kind, v] of [...byKind].sort((a, b) => b[1].weight - a[1].weight)) {
    lines.push(`- ${kind}: ${pct(v.weight, claudeTotal)} (${v.runs} runs)`)
  }
  const codexRows = usage.filter((u) => u.agent === 'codex')
  if (codexRows.length) {
    const codexTotal = sum(codexRows.map((u) => weight(u)))
    const kinds = new Map<string, { weight: number; runs: number }>()
    for (const u of codexRows) {
      const v = kinds.get(u.kind) ?? { weight: 0, runs: 0 }
      v.weight += weight(u)
      v.runs += u.runs
      kinds.set(u.kind, v)
    }
    lines.push('', `## Codex, by kind of work (total ${k(codexTotal)}, on its own plan)`)
    for (const [kind, v] of [...kinds].sort((a, b) => b[1].weight - a[1].weight)) lines.push(`- ${kind}: ${pct(v.weight, codexTotal)} (${v.runs} runs)`)
  }
  const clineRows = usage.filter((u) => u.agent === 'cline')
  if (clineRows.length) {
    const clineTotal = sum(clineRows.map((u) => weight(u)))
    const kinds = new Map<string, { weight: number; runs: number }>()
    for (const u of clineRows) {
      const v = kinds.get(u.kind) ?? { weight: 0, runs: 0 }
      v.weight += weight(u)
      v.runs += u.runs
      kinds.set(u.kind, v)
    }
    lines.push('', `## Cline, by kind of work (total ${k(clineTotal)}, on the ClinePass plan; background jobs here no longer use Claude)`)
    for (const [kind, v] of [...kinds].sort((a, b) => b[1].weight - a[1].weight)) lines.push(`- ${kind}: ${pct(v.weight, clineTotal)} (${v.runs} runs)`)
  }

  // ---- requests: who did what
  if (!requests.length) {
    lines.push('', 'No Build or Plan requests recorded in this period (requests are recorded from this version on).')
    return lines.join('\n')
  }
  const reqWeight = (r: RequestLogRow): number => weight(r.claude, r.model)
  lines.push('', `## Requests (${requests.length})`)
  const modes = new Map<string, RequestLogRow[]>()
  for (const r of requests) modes.set(r.mode, [...(modes.get(r.mode) ?? []), r])
  for (const [mode, rows] of modes) {
    const tools: Record<string, number> = {}
    for (const r of rows) addTools(tools, r.tools)
    const withHandoff = rows.filter((r) => r.handoffs > 0).length
    lines.push(
      `- ${MODE_LABELS[mode] ?? mode}: ${rows.length}, avg ${Math.round(sum(rows.map((r) => r.claudeSteps)) / rows.length)} Claude steps and ${k(sum(rows.map(reqWeight)) / rows.length)} each; ${withHandoff} used Codex. Claude's tool calls: ${stepMix(tools)}`
    )
  }

  // ---- the Claude/Codex split: where the slider asked for Codex
  const codexRouted = requests.filter((r) => r.mode !== 'plan' && r.mode !== 'takeover' && /Codex/i.test(r.route ?? ''))
  if (codexRouted.length) {
    const handedOff = codexRouted.filter((r) => r.handoffs > 0)
    const after = (kind: StepKind): number => handedOff.filter((r) => (r.tools[kind] ?? 0) > 0).length
    lines.push(
      '',
      `## Teamwork (${codexRouted.length} requests the slider sent to Codex)`,
      `- Called Codex: ${handedOff.length} (${pct(handedOff.length, codexRouted.length)}). Didn't: ${codexRouted.length - handedOff.length}.`,
      `- After handing off, Claude still edited files in ${after('edit')}, checked in a browser in ${after('browser')}, ran server commands in ${after('server')} and local commands in ${after('command')}.`,
      `- Claude's share of the work there: ${stepMix(Object.fromEntries(Object.entries(handedOff.reduce<Record<string, number>>((acc, r) => (addTools(acc, r.tools), acc), {})).filter(([kind]) => kind !== 'handoff')))}`,
      `- Codex tokens per hand-off request: ${k(sum(handedOff.map((r) => weight(r.codex))) / Math.max(1, handedOff.length))}; Claude's: ${k(sum(handedOff.map(reqWeight)) / Math.max(1, handedOff.length))}.`
    )
  }
  const toCline = requests.filter((r) => (r.tools.cline ?? 0) > 0)
  if (toCline.length) {
    lines.push(
      `- Cline: ${toCline.length} request${toCline.length === 1 ? '' : 's'} handed work to Cline (${sum(toCline.map((r) => r.tools.cline ?? 0))} hand-offs, ${k(sum(toCline.map((r) => weight(r.cline))))} Cline tokens; Claude's per request there: ${k(sum(toCline.map(reqWeight)) / toCline.length)}).`
    )
  }
  const deployByHand = requests.filter((r) => (r.tools.server ?? 0) >= 3).length
  const savedDeploys = requests.filter((r) => (r.tools.deploy ?? 0) > 0).length
  if (deployByHand || savedDeploys) {
    lines.push(`- Deploys: ${savedDeploys} with the saved Deploy, ${deployByHand} requests ran 3+ server commands by hand.`)
  }

  // ---- the most expensive requests
  lines.push('', '## Most expensive requests')
  for (const r of [...requests].sort((a, b) => reqWeight(b) - reqWeight(a)).slice(0, 6)) {
    lines.push(
      `- ${r.at.slice(0, 16).replace('T', ' ')} ${name(r.projectId)} · ${MODE_LABELS[r.mode] ?? r.mode} · "${r.text.replace(/\s+/g, ' ').slice(0, 70)}" · ${r.claudeSteps} steps, ${k(reqWeight(r))}, ${r.handoffs} hand-off(s), ${Math.round(r.seconds / 60)} min${r.outcome !== 'done' ? ` · ${r.outcome}` : ''}. ${stepMix(r.tools, 4)}`
    )
  }
  return lines.join('\n')
}
