import type { AppSettings } from '@shared/types'
import { peekUsage, percentLeft } from '../usage/usage'
import { requestClassifier, type Classification } from './classifier'

export interface RouteDecision {
  /** Model to use for this message; null = the user's chosen model (or account default). */
  model: string | null
  /** Shown under the message when smart switching changed something. */
  label?: string
  reason?: string
  /** Why Haiku labelled the request the way it did (shown on hover). */
  detail?: string
  /** Extra guidance for Claude, sent ahead of the user's message. */
  note?: string
  /** Too small to be worth a Codex review. */
  skipReview: boolean
}

/** Below this share of a plan window left, start saving Claude usage. */
const CLAUDE_LOW = 25
/** Below this share left, stop sending work to Codex. */
const CODEX_LOW = 15

// Fallback when Haiku can't answer in time: small, self-contained tweaks
// (styling, wording, sizes). Deliberately narrow.
const QUICK_EDIT =
  /\b(colou?rs?|fonts?|text|wording|words?|typos?|spelling|rename|labels?|titles?|headings?|padding|margins?|spacing|bigger|smaller|larger|wider|narrower|taller|shorter|sizes?|align(ed)?|cent(er|re)(ed)?|bold|italic|underline|icons?|emojis?|borders?|rounded|corners?|shadows?|background|copy|placeholder|capitali[sz]e)\b/i
const NOT_QUICK =
  /\b(build|create|make an?|implement|add(ing)? (an?|new|support)|feature|refactor|debug|why|crash(es|ing)?|broken|break|doesn'?t|isn'?t|won'?t|error|bug|database|auth|log ?in|sign ?up|api|deploy|test|install|set ?up|integrat\w*|migrat\w*|performance|security|every|all (the )?pages|whole|entire)\b/i

export function isQuickEdit(text: string): boolean {
  return text.length <= 160 && !text.includes('\n') && QUICK_EDIT.test(text) && !NOT_QUICK.test(text)
}

function keywordClassification(text: string, images: number): Classification {
  // A screenshot usually means "make it look like this": rarely a quick edit.
  return { size: isQuickEdit(text) && images === 0 ? 'quick' : 'normal', codex: 'none', reason: '' }
}

const CHEAP_MODELS = /haiku|sonnet/i

const CODEX_NOTES = {
  most: 'This request is mostly straightforward implementation, so Codex should build it: plan the work, then call run_codex_subtask with a clear spec and acceptance criteria before writing the code yourself. Afterwards, review what Codex did and fix anything off.',
  some: 'Part of this request is independent and well-scoped. Consider handing that part to Codex with run_codex_subtask while you do the rest; skip it if doing it yourself is clearly quicker.'
}

export async function routeMessage(
  text: string,
  settings: AppSettings,
  context: { images?: number; pointedAt?: boolean } = {}
): Promise<RouteDecision> {
  if (!settings.smartRouting) return { model: null, skipReview: false }
  const images = context.images ?? 0
  const labelled = settings.aiRouting ? await requestClassifier.classify(text, { images, pointedAt: context.pointedAt }) : null
  const request = labelled ?? keywordClassification(text, images)

  const baseline = settings.claudeModel
  const claudeLeft = percentLeft(peekUsage('claude'))
  const codexLeft = percentLeft(peekUsage('codex'))
  const claudeLow = claudeLeft !== undefined && claudeLeft < CLAUDE_LOW
  const codexLow = codexLeft !== undefined && codexLeft < CODEX_LOW

  // How much goes to Codex: Haiku's call, adjusted for what each plan has left.
  let codex = request.codex
  if (codexLow) codex = 'none'
  else if (claudeLow && codex === 'some') codex = 'most'

  const notes: string[] = []
  if (codexLow) {
    notes.push(`Codex plan usage is nearly used up (${Math.round(codexLeft)}% left). Don't delegate to Codex for this request; do the work yourself.`)
  } else if (codex !== 'none') {
    notes.push(CODEX_NOTES[codex])
    if (claudeLow) notes.push(`Claude plan usage is also low (${Math.round(claudeLeft)}% left), so lean on Codex.`)
  } else if (claudeLow && codexLeft !== undefined && request.size !== 'quick') {
    notes.push(`Claude plan usage is low (${Math.round(claudeLeft)}% left). Delegate implementation work to Codex with run_codex_subtask wherever it's reasonable, and keep your own work to planning, coordination and review.`)
  }
  // Checking and saving memory would cost more than a quick edit itself.
  if (request.size === 'quick') notes.push('This is a quick edit: skip the memory tools.')
  const note = notes.length ? `[VibeApp note: ${notes.join(' ')}]` : undefined

  // Which Claude model.
  let model: string | null = null
  let modelLabel: string | undefined
  let modelReason: string | undefined
  const choseHaiku = !!baseline && /haiku/i.test(baseline)
  if (!choseHaiku) {
    if (request.size === 'quick') {
      model = 'haiku'
      modelLabel = 'Haiku'
      modelReason = 'quick edit'
    } else if (request.size === 'complex' && baseline && CHEAP_MODELS.test(baseline)) {
      model = 'opus'
      modelLabel = 'Opus'
      modelReason = 'complex request'
    } else if (request.size === 'normal' && claudeLow && !(baseline && CHEAP_MODELS.test(baseline))) {
      model = 'sonnet'
      modelLabel = 'Sonnet'
      modelReason = `saving Claude usage (${Math.round(claudeLeft)}% left)`
    }
  }

  // "some" is a suggestion Claude may turn down, so the tag says so.
  const codexReason =
    codex === 'most' ? 'Codex does most of the work' : codex === 'some' ? 'Codex suggested for a part' : undefined
  const reasons = [modelReason, codexReason].filter(Boolean) as string[]
  return {
    model,
    label: modelLabel ?? (codexReason ? 'Codex' : undefined),
    reason: modelLabel
      ? reasons.join(' · ')
      : codex === 'most'
        ? 'does most of the work'
        : codex === 'some'
          ? 'suggested for a part'
          : undefined,
    detail: labelled
      ? `Haiku: ${request.size}${request.reason ? ` (${request.reason})` : ''}`
      : settings.aiRouting
        ? 'Keyword rules (Haiku was unavailable)'
        : 'Keyword rules',
    note,
    skipReview: request.size === 'quick'
  }
}
