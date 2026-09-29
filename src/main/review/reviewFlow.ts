import type { VibeEvent } from '@shared/types'
import type { ClaudeSession } from '../orchestrator/session'
import { takeSnapshot } from '../git/snapshots'
import { getSettings } from '../settings/store'
import { peekUsage, percentLeft } from '../usage/usage'
import { changesBetween, fixPrompt, reviewChanges } from './codexReview'
import { scanDiff } from '../secrets/leakScan'
import { secretValues } from '../secrets/vault'

/** Below this share of Codex plan left, skip reviews to save it for real work. */
const CODEX_REVIEW_MIN_LEFT = 15

interface TurnContext {
  projectPath: string
  request: string
  /** Files as they were before the user's message. */
  snapshot?: string
  skipReview: boolean
  phase: 'main' | 'reviewing' | 'fixing'
  hadError: boolean
  abort?: AbortController
  /** Emits the held-back turn_complete (used by "Skip review"). */
  finishNow?: () => void
}

const turns = new Map<string, TurnContext>()

export function beginTurn(
  projectId: string,
  context: Pick<TurnContext, 'projectPath' | 'request' | 'snapshot' | 'skipReview'>
): void {
  turns.get(projectId)?.abort?.abort()
  turns.set(projectId, { ...context, phase: 'main', hadError: false })
}

function reviewAllowed(): boolean {
  if (!getSettings().codexReview) return false
  const codex = peekUsage('codex')
  if (codex?.status === 'error') return false // not installed or not logged in
  const left = percentLeft(codex)
  return left === undefined || left >= CODEX_REVIEW_MIN_LEFT
}

/**
 * Sits between a Claude session's events and the UI. When Claude finishes a
 * request that changed code, the turn_complete is held back while Codex
 * reviews the change; if Codex finds real problems, Claude is asked to fix
 * them in the same turn, so the user sees one finished result.
 */
export function handleSessionEvent(
  projectId: string,
  session: ClaudeSession,
  event: VibeEvent,
  forward: (event: VibeEvent) => void
): void {
  const turn = turns.get(projectId)
  // An error or a Stop leaves a half-finished change: not worth reviewing.
  if (turn && (event.type === 'error' || event.type === 'stopped')) turn.hadError = true

  if (event.type !== 'turn_complete' || !turn || turn.phase === 'reviewing') {
    forward(event)
    return
  }
  if (!turn.snapshot) {
    turns.delete(projectId)
    forward(event)
    return
  }
  const wantReview =
    turn.phase === 'main' && !turn.skipReview && !turn.hadError && !session.isDead() && reviewAllowed()

  turn.phase = 'reviewing'
  const abort = new AbortController()
  turn.abort = abort
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    if (turns.get(projectId) === turn) turns.delete(projectId)
    forward({ type: 'turn_complete' })
  }
  turn.finishNow = () => {
    abort.abort()
    if (reviewStarted) {
      forward({ type: 'review_result', ok: false, summary: 'Review skipped.', findings: [], fixing: false })
    }
    finish()
  }

  let reviewStarted = false
  void (async () => {
    try {
      const after = await takeSnapshot(turn.projectPath, `after: ${turn.request}`)
      const diff = await changesBetween(turn.projectPath, turn.snapshot!, after)
      const leaks = scanDiff(diff, secretValues(projectId))
      if (leaks.length) forward({ type: 'secret_leak', leaks })
      if (!wantReview || !diff.trim() || abort.signal.aborted) return finish()

      reviewStarted = true
      forward({ type: 'review_started' })
      const review = await reviewChanges(turn.projectPath, diff, turn.request, abort.signal)
      if (finished || abort.signal.aborted) return

      const serious = review.findings.filter((f) => f.severity !== 'low')
      const fixing = serious.length > 0 && !session.isDead()
      forward({ type: 'review_result', ok: true, summary: review.summary, findings: review.findings, fixing })
      if (!fixing) return finish()

      // Claude's fix turn ends with its own turn_complete; in the 'fixing'
      // phase that gets the leak check but no second review.
      turn.phase = 'fixing'
      turn.finishNow = undefined
      session.send(fixPrompt(serious))
    } catch (err) {
      if (finished || abort.signal.aborted) return
      if (!reviewStarted) return finish() // only the leak check failed; nothing to report
      forward({
        type: 'review_result',
        ok: false,
        summary: `Codex couldn't review this change: ${(err as Error).message}`,
        findings: [],
        fixing: false
      })
      finish()
    }
  })()
}

/** The user chose not to wait for the review. Returns false if no review was running. */
export function skipReview(projectId: string): boolean {
  const finishNow = turns.get(projectId)?.finishNow
  finishNow?.()
  return !!finishNow
}
