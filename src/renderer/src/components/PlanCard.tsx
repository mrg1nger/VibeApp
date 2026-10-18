import { useState } from 'react'
import Markdown from './Markdown'

interface PlanCardProps {
  plan: string
  steps: { text: string; who?: 'claude' | 'codex' }[]
  status: 'pending' | 'approved' | 'revised' | 'cancelled'
  progress: Record<number, 'doing' | 'done'>
  busy: boolean
  onApprove: () => void
  onRevise: (feedback: string) => void
  onCancel: () => void
}

const STATUS_LABEL: Record<PlanCardProps['status'], string> = {
  pending: 'Waiting for you',
  approved: 'Approved',
  revised: 'Changes asked for',
  cancelled: 'Cancelled'
}

/** A plan Claude proposed in Plan mode: approve it to build, ask for changes, or cancel. */
function PlanCard({ plan, steps, status, progress, busy, onApprove, onRevise, onCancel }: PlanCardProps) {
  const [changing, setChanging] = useState(false)
  const [feedback, setFeedback] = useState('')
  // The steps are listed above; the full text is there for anyone who wants it.
  const [showAll, setShowAll] = useState(steps.length === 0)
  const done = Object.values(progress).filter((p) => p === 'done').length

  return (
    <div className={`plan-card plan-card-${status}`}>
      <div className="plan-card-header">
        <span>📋 Plan</span>
        <span className="plan-card-status">
          {STATUS_LABEL[status]}
          {status === 'approved' && steps.length > 0 ? ` · ${done} of ${steps.length} done` : ''}
        </span>
      </div>

      {steps.length > 0 && (
        <ol className="plan-steps">
          {steps.map((s, i) => {
            const state = progress[i + 1]
            return (
              <li key={i} className={`plan-step${state ? ` plan-step-${state}` : ''}`}>
                <span className="plan-step-mark" aria-hidden>
                  {state === 'done' ? '✓' : state === 'doing' ? '▶' : '○'}
                </span>
                <span className="plan-step-text">
                  {s.who && <span className={`plan-who plan-who-${s.who}`}>{s.who === 'codex' ? 'Codex' : 'Claude'}</span>}
                  {s.text}
                </span>
              </li>
            )
          })}
        </ol>
      )}

      <details className="plan-full" open={showAll || steps.length === 0} onToggle={(e) => setShowAll((e.target as HTMLDetailsElement).open)}>
        <summary>The whole plan</summary>
        <Markdown text={plan || '(Claude did not include any text.)'} />
      </details>

      {status === 'pending' && !changing && (
        <div className="plan-actions">
          <button className="plan-approve" disabled={busy} onClick={onApprove}>
            ✅ Approve and build
          </button>
          <button disabled={busy} onClick={() => setChanging(true)}>
            ✏️ Change it
          </button>
          <button disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}

      {status === 'pending' && changing && (
        <div className="plan-change">
          <textarea
            autoFocus
            rows={3}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should be different? e.g. keep the old menu, and let Codex do the tests"
          />
          <div className="plan-actions">
            <button
              className="plan-approve"
              disabled={busy || !feedback.trim()}
              onClick={() => {
                onRevise(feedback.trim())
                setChanging(false)
                setFeedback('')
              }}
            >
              Revise the plan
            </button>
            <button onClick={() => setChanging(false)}>Back</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default PlanCard
