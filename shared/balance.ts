// How work is split between Claude (leads, plans, reviews) and Codex
// (builds hand-offs). The user moves a slider; "auto" follows plan headroom.

export const BALANCE_STEPS = ['claude', 'lean-claude', 'balanced', 'lean-codex', 'codex'] as const
export type BalanceStep = (typeof BALANCE_STEPS)[number]
export type AgentBalance = 'auto' | BalanceStep

export const BALANCE_LABELS: Record<BalanceStep, string> = {
  claude: 'Claude-led',
  'lean-claude': 'Leaning Claude',
  balanced: 'Balanced',
  'lean-codex': 'Leaning Codex',
  codex: 'Codex-led'
}

export const BALANCE_HELP: Record<BalanceStep, string> = {
  claude: 'Claude does the work itself. Codex is only used for reviews and clearly separate pieces.',
  'lean-claude': 'Claude does most of the work; Codex gets at most a separate piece of bigger requests.',
  balanced: 'VibeApp decides, request by request, how much suits Codex.',
  'lean-codex': 'Straightforward implementation goes to Codex more often; Claude plans and reviews.',
  codex: 'Claude plans and reviews; Codex builds nearly everything that isn\'t a quick tweak.'
}

/** -2 (all Claude) .. +2 (all Codex). */
export function leanOfStep(step: BalanceStep): number {
  return BALANCE_STEPS.indexOf(step) - 2
}

export function stepOfLean(lean: number): BalanceStep {
  return BALANCE_STEPS[Math.max(0, Math.min(4, Math.round(lean) + 2))]
}

/**
 * Auto: lean toward whichever plan has more left. Inputs are the share of
 * each plan's tightest window still available (0-100); unknown means balanced.
 */
export function autoLean(claudeLeft: number | undefined, codexLeft: number | undefined): number {
  if (claudeLeft === undefined || codexLeft === undefined) return 0
  const diff = codexLeft - claudeLeft
  if (diff >= 40) return 2
  if (diff >= 15) return 1
  if (diff <= -40) return -2
  if (diff <= -15) return -1
  return 0
}

export function leanFor(balance: AgentBalance, claudeLeft?: number, codexLeft?: number): number {
  return balance === 'auto' ? autoLean(claudeLeft, codexLeft) : leanOfStep(balance)
}

export type CodexShare = 'none' | 'some' | 'most'
const SHARES: CodexShare[] = ['none', 'some', 'most']

/**
 * How much of a request goes to Codex once the slider is applied to
 * Haiku's judgement. Quick requests are never delegated.
 */
export function applyBalance(
  share: CodexShare,
  size: 'quick' | 'normal' | 'complex',
  lean: number
): CodexShare {
  if (size === 'quick') return 'none'
  let i = SHARES.indexOf(share)
  if (lean <= -2) i = size === 'complex' ? Math.min(i, 1) : 0
  else if (lean === -1) i = Math.min(i, 1)
  else if (lean === 1) i = Math.min(2, i + 1)
  else if (lean >= 2) i = 2
  return SHARES[i]
}
