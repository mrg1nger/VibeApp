// Plan mode: Claude explores read-only and proposes a plan; the user approves
// it (then it's built step by step), asks for changes, or cancels.

export interface PlanStep {
  text: string
  /** Who should do it, when the plan says. */
  who?: 'claude' | 'codex'
}

/** What Claude is told about writing a plan (Claude Code adds its own read-only rules around it). */
export const PLAN_INSTRUCTIONS = `The user is planning this change before anything is built, and may not be technical. Explore the project read-only to understand what is there: keep it cheap (use the explorer helper and the memory tools mcp__vibe_memory__where / recall before reading many files yourself). Then write the plan in this shape:
- One short paragraph saying, in plain words, what will be done and how.
- A section "## Steps" with at most 8 numbered steps. Start each step with "(Claude)" or "(Codex)" for who should do it, following any note about the Claude/Codex balance: give Codex self-contained building steps, and keep design, integration and review with Claude. Say which files each step touches.
- A section "## Risks" only if there is something the user should know before saying yes.
Do not write the code itself in the plan.`

/** The numbered steps of a plan's "Steps" section (or of the first numbered list, if there is no such section). */
export function parsePlanSteps(plan: string): PlanStep[] {
  const lines = plan.replace(/\r\n/g, '\n').split('\n')
  let start = lines.findIndex((l) => /^#{1,4}\s*(implementation\s+)?steps\b/i.test(l.trim()))
  if (start === -1) start = lines.findIndex((l) => /^\s*1[.)]\s+\S/.test(l)) - 1
  if (start < -1) return []
  const steps: PlanStep[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,4}\s/.test(line.trim()) && steps.length) break // the next section
    const m = /^\s*(\d+)[.)]\s+(.*\S)\s*$/.exec(line)
    if (!m) continue
    let text = m[2].replace(/^\*\*(.+?)\*\*/, '$1')
    let who: PlanStep['who']
    const tag = /^[(*[\s]*(claude|codex)[)\]*:\s-]+/i.exec(text)
    if (tag) {
      who = tag[1].toLowerCase() as PlanStep['who']
      text = text.slice(tag[0].length).trim()
    }
    steps.push({ text: text.slice(0, 300), who })
  }
  return steps.slice(0, 20)
}

/** The note that goes with "build it" after the user approves a plan. */
export function approvedPlanNote(plan: string): string {
  return `[VibeApp note: the user approved the plan below. Build it now, following its steps in order. When you start a step call mcp__vibe_tools__plan_progress with that step's number and status "doing", and when it is finished call it again with status "done". Hand the steps marked (Codex) to Codex with run_codex_subtask. If something in the plan turns out to be wrong, say so briefly and adapt.]

Approved plan:
${plan}`
}
