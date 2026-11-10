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
- A section "## Steps" with at most 8 numbered steps. Start each step with "(Claude)" or "(Codex)" for who should do it, following any note about the Claude/Codex balance: give Codex self-contained building steps, and keep design, integration and review with Claude. Say which files each step touches. Checking the work (tests, a look in the browser) belongs in the step that builds it, so whoever builds it checks it; don't make it a separate step for Claude. A deploy is its own last step, "(Claude) Deploy with the saved Deploy", when the user wants it live.
- A section "## Risks" only if there is something the user should know before saying yes.
Do not write the code itself in the plan.`

/** Claude's plan mode only (Codex plans in a read-only sandbox and has no leave_plan_mode). */
export const CLAUDE_PLAN_LIMITS = `While planning, VibeApp turns away anything that changes something: editing files, commands that aren't read-only (ssh included), Deploy and hand-offs to Codex or Cline. Put those in the plan as steps. If the user's message needs something done now rather than planned (for example "done, go ahead and deploy"), call mcp__vibe_tools__leave_plan_mode once with what and why; VibeApp asks the user.`

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
  return `[VibeApp note: the user approved the plan below. Build it now, following its steps in order. Report progress with mcp__vibe_tools__plan_progress, one call per step: status "doing" for the first step, then, as each step finishes, status "done" with next set to the step you start next (leave next out after the last one). Hand the steps marked (Codex) to Codex with run_codex_subtask, including how to check them, and judge them from Codex's report rather than testing again yourself. For a deploy step, call mcp__vibe_tools__run_deploy. If something in the plan turns out to be wrong, say so briefly and adapt.]

Approved plan:
${plan}`
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'into', 'from', 'then', 'add', 'make', 'file', 'files'])

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter((w) => !STOP_WORDS.has(w)))
}

/**
 * Claude's own to-do list, read as progress on the plan's steps: same number
 * of items means one each, in order; otherwise each step takes the to-do item
 * sharing most of its words (if enough do).
 */
export function matchTodosToSteps(
  todos: { content: string; status: string }[],
  steps: PlanStep[]
): ('doing' | 'done' | undefined)[] {
  const status = (s: string): 'doing' | 'done' | undefined => (s === 'completed' ? 'done' : s === 'in_progress' ? 'doing' : undefined)
  if (todos.length === steps.length) return todos.map((t) => status(t.status))
  return steps.map((step) => {
    const want = words(step.text)
    let best: { score: number; todo?: { content: string; status: string } } = { score: 0 }
    for (const todo of todos) {
      const have = words(todo.content)
      let shared = 0
      for (const w of want) if (have.has(w)) shared++
      const score = want.size ? shared / Math.min(want.size, Math.max(have.size, 1)) : 0
      if (score > best.score) best = { score, todo }
    }
    return best.todo && best.score >= 0.4 ? status(best.todo.status) : undefined
  })
}

/** "STEP 2: done" lines (how Codex reports progress on a plan), in order. */
export function progressMarkers(text: string): { step: number; status: 'doing' | 'done' }[] {
  const out: { step: number; status: 'doing' | 'done' }[] = []
  for (const m of text.matchAll(/\bSTEP\s+(\d{1,2})\s*[:\-–]\s*(doing|done)\b/gi)) {
    out.push({ step: Number(m[1]), status: m[2].toLowerCase() as 'doing' | 'done' })
  }
  return out
}

/** A request long or many-parted enough that planning it first is likely worth it. */
export function looksBig(text: string): boolean {
  const items = (text.match(/^\s*(?:[-*•]|\d+[.)])\s+\S/gm) ?? []).length
  return text.trim().length > 700 || items >= 4
}

/** What Codex is told when it builds a plan the user approved (it can't call VibeApp's progress tool). */
export function codexPlanBuildNote(plan: string): string {
  return `The user approved the plan below; build it now, following its steps in order (all of them, including any marked for Claude: Claude isn't available right now). Before you start each step, write a line on its own saying "STEP <number>: doing", and when it's finished "STEP <number>: done", so the user can follow along.

Approved plan:
${plan}`
}
