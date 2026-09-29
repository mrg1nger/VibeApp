import type { AppSettings } from '@shared/types'
import { peekUsage, percentLeft } from '../usage/usage'

export interface RouteDecision {
  /** Model to use for this message; null = the user's chosen model (or account default). */
  model: string | null
  /** Shown under the message when smart switching changed something. */
  label?: string
  reason?: string
  /** Extra guidance for Claude, sent ahead of the user's message. */
  note?: string
}

/** Below this share of a plan window left, start saving Claude usage. */
const CLAUDE_LOW = 25
/** Below this share left, stop sending work to Codex. */
const CODEX_LOW = 15

// Small, self-contained tweaks: styling, wording, sizes. Deliberately narrow:
// a false "quick" just means Haiku handles something a bit harder, but these
// patterns rarely need more.
const QUICK_EDIT =
  /\b(colou?rs?|fonts?|text|wording|words?|typos?|spelling|rename|labels?|titles?|headings?|padding|margins?|spacing|bigger|smaller|larger|wider|narrower|taller|shorter|sizes?|align(ed)?|cent(er|re)(ed)?|bold|italic|underline|icons?|emojis?|borders?|rounded|corners?|shadows?|background|copy|placeholder|capitali[sz]e)\b/i
const NOT_QUICK =
  /\b(build|create|make an?|implement|add(ing)? (an?|new|support)|feature|refactor|debug|why|crash(es|ing)?|broken|break|doesn'?t|isn'?t|won'?t|error|bug|database|auth|log ?in|sign ?up|api|deploy|test|install|set ?up|integrat\w*|migrat\w*|performance|security|every|all (the )?pages|whole|entire)\b/i

export function isQuickEdit(text: string): boolean {
  return text.length <= 160 && !text.includes('\n') && QUICK_EDIT.test(text) && !NOT_QUICK.test(text)
}

const CHEAP_MODELS = /haiku|sonnet/i

export function routeMessage(text: string, settings: AppSettings): RouteDecision {
  if (!settings.smartRouting) return { model: null }
  const baseline = settings.claudeModel
  const claudeLeft = percentLeft(peekUsage('claude'))
  const codexLeft = percentLeft(peekUsage('codex'))
  const claudeLow = claudeLeft !== undefined && claudeLeft < CLAUDE_LOW
  const codexLow = codexLeft !== undefined && codexLeft < CODEX_LOW

  const notes: string[] = []
  if (claudeLow && codexLeft !== undefined && !codexLow) {
    notes.push(
      `Claude plan usage is low (${Math.round(claudeLeft)}% left). Delegate implementation work to Codex with run_codex_subtask wherever it's reasonable, and keep your own work to planning, coordination and review.`
    )
  } else if (codexLow) {
    notes.push(
      `Codex plan usage is nearly used up (${Math.round(codexLeft)}% left). Don't delegate to Codex for this request; do the work yourself.`
    )
  }
  const note = notes.length ? `[VibeApp note: ${notes.join(' ')}]` : undefined

  if (baseline && /haiku/i.test(baseline)) return { model: null, note }

  if (isQuickEdit(text)) {
    return { model: 'haiku', label: 'Haiku', reason: 'quick edit', note }
  }
  if (claudeLow && !(baseline && CHEAP_MODELS.test(baseline))) {
    return {
      model: 'sonnet',
      label: 'Sonnet',
      reason: `saving Claude usage (${Math.round(claudeLeft)}% left)`,
      note
    }
  }
  return { model: null, note }
}
