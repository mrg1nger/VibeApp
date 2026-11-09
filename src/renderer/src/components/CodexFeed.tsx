import { useEffect, useState } from 'react'
import type { DelegationActivity } from '@shared/types'
import { shortenProjectPaths } from '../lib/labels'

interface CodexFeedProps {
  steps: DelegationActivity[]
  running: boolean
  /** When the hand-off started (ms), for the elapsed clock. */
  startedAt?: number
  projectPath: string
  /** Who's doing the hand-off (default Codex). */
  agent?: 'Codex' | 'Cline'
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * What Codex is doing during a hand-off: its own narration, the files it
 * changes, and the commands it runs with their output. Open while it works,
 * folded away once it's done.
 */
function CodexFeed({ steps, running, startedAt, projectPath, agent = 'Codex' }: CodexFeedProps) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  if (!steps.length && !running) return null
  const short = (text: string): string => shortenProjectPaths(text, projectPath)
  const finished = steps.filter((s) => s.done).length

  return (
    <details className="codex-feed" open={running}>
      <summary>
        {running
          ? `${agent} is working${startedAt ? ` · ${clock(now - startedAt)}` : ''}`
          : `${agent}'s work · ${finished} step${finished === 1 ? '' : 's'}`}
      </summary>
      <ul>
        {steps.length === 0 && <li className="codex-step codex-step-wait">Starting up…</li>}
        {steps.map((step) => (
          <li key={step.id} className={`codex-step codex-step-${step.step}${step.ok === false ? ' codex-step-failed' : ''}`}>
            {step.step === 'say' ? (
              <span className="codex-say">{short(step.text)}</span>
            ) : (
              <>
                <span className="codex-step-icon">
                  {step.step === 'edit' ? '✏️' : step.step === 'run' ? '▶' : '🧰'}
                </span>
                {step.step === 'run' ? (
                  <code title={step.full ? short(step.full) : undefined}>{short(step.text)}</code>
                ) : (
                  <span>{short(step.text)}</span>
                )}
                <span className="codex-step-status">
                  {!step.done ? '…' : step.ok === false ? '✗ failed' : '✓'}
                </span>
                {step.detail && <pre>{short(step.detail)}</pre>}
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}

export default CodexFeed
