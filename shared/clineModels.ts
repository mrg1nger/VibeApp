// What VibeApp's own tests found for each ClinePass model, shown next to it in Settings.
// Memory: `VIBEAPP_EVAL_HELPERS=all npm run eval -- helpers` (6 memory-saving cases).
// Coding: `npm run eval -- cline-coding` (3 small tasks scored by the project's tests).

export const CLINE_TESTED_ON = '2026-11-10'

export interface ClineModelNote {
  /** Memory test score, e.g. "6/6". */
  memory?: string
  /** Coding test score, e.g. "3/3". */
  coding?: string
  /** Seconds per coding task. */
  seconds?: number
  /** ClinePass listed it but refused to run it when tested. */
  refused?: boolean
}

// Every model ClinePass runs got the three coding tasks right, so speed tells them apart there.
// Every model ClinePass runs also got all six memory cases right (rerun for 0.5.5: the earlier
// 4/5 scores came from the test, which let one model's saved rule count as known to the next).
export const CLINE_MODEL_NOTES: Record<string, ClineModelNote> = {
  'cline-pass/kimi-k3.1-pro': { coding: '3/3', seconds: 19, memory: '18/18 over 3 runs' },
  'cline-pass/deepseek-v4.1-flash-1017': { coding: '3/3', seconds: 16, memory: '6/6' },
  'cline-pass/deepseek-v4-pro': { coding: '3/3', seconds: 24, memory: '6/6' },
  'cline-pass/qwen3.8-max': { coding: '3/3', seconds: 25, memory: '6/6' },
  'cline-pass/glm-5.3': { coding: '3/3', seconds: 34, memory: '6/6' },
  'cline-pass/deepseek-v4.1-flash': { coding: '3/3', seconds: 40, memory: '6/6' },
  'cline-pass/muse-spark-1.3-contributor': { coding: '3/3', seconds: 40, memory: '6/6' },
  'cline-pass/kimi-k3': { coding: '3/3', seconds: 43, memory: '6/6' },
  'cline-pass/glm-5.3-flash': { coding: '3/3', seconds: 51, memory: '6/6' },
  'cline-pass/minimax-m3.1-flash': { coding: '3/3', seconds: 57, memory: '18/18 over 3 runs' },
  'cline-pass/minimax-m3': { refused: true },
  'cline-pass/mimo-v2.6-flash': { refused: true },
  'cline-pass/mimo-v2.6-pro': { refused: true },
  'cline-pass/qwen3.7-plus': { refused: true },
  'cline-pass/qwen3.7-max': { refused: true }
}

/** The picks, from the tests: Kimi K3.1 Pro (also ClinePass's own default) for both. */
export const CLINE_RECOMMENDED = {
  handoff: 'cline-pass/kimi-k3.1-pro' as string | undefined,
  helper: 'cline-pass/kimi-k3.1-pro' as string | undefined
}

/** A model's line in the menu: its name, the test results, and whether it's the pick. */
export function clineModelLabel(id: string, name: string, use: 'handoff' | 'helper'): string {
  const note = CLINE_MODEL_NOTES[id]
  const parts: string[] = []
  if (CLINE_RECOMMENDED[use] === id) parts.push('recommended')
  if (note?.refused) parts.push('refused when tested')
  else if (use === 'handoff' && note?.coding) parts.push(`coding ${note.coding}${note.seconds ? `, ~${Math.round(note.seconds)} s` : ''}`)
  else if (use === 'helper' && note?.memory) parts.push(`memory ${note.memory}`)
  return parts.length ? `${name} (${parts.join(' · ')})` : name
}
