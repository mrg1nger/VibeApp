import { useCallback, useEffect, useState } from 'react'
import type { CliName, CliStatus, UsageSnapshot } from '@shared/types'

interface UsageMetersProps {
  statuses: Record<CliName, CliStatus>
}

const POLL_INTERVAL_MS = 3 * 60_000
const CLIS: { cli: CliName; name: string }[] = [
  { cli: 'claude', name: 'Claude' },
  { cli: 'codex', name: 'Codex' }
]

function formatReset(resetsAt: number | null): string {
  if (!resetsAt) return ''
  const mins = Math.max(0, Math.round((resetsAt - Date.now()) / 60_000))
  if (mins < 60) return `resets in ${mins}m`
  if (mins < 48 * 60) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`
  return `resets ${new Date(resetsAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`
}

function levelClass(usedPercent: number): string {
  if (usedPercent >= 90) return 'usage-danger'
  if (usedPercent >= 75) return 'usage-warning'
  return ''
}

/** Compact plan-usage bars for Claude and Codex, shown in the top bar. */
function UsageMeters({ statuses }: UsageMetersProps) {
  const [usage, setUsage] = useState<Partial<Record<CliName, UsageSnapshot>>>({})

  const refresh = useCallback(
    (force = false) => {
      for (const { cli } of CLIS) {
        if (statuses[cli].status !== 'logged_in') continue
        window.vibe.usage
          .get(cli, force)
          .then((snapshot) => setUsage((prev) => ({ ...prev, [cli]: snapshot })))
          .catch(() => undefined)
      }
    },
    [statuses.claude.status, statuses.codex.status] // eslint-disable-line react-hooks/exhaustive-deps
  )

  useEffect(() => {
    refresh()
    const interval = setInterval(() => refresh(), POLL_INTERVAL_MS)
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  // Usage moves when a turn finishes (Claude's own work and any Codex
  // delegation inside it), so check again then.
  useEffect(
    () =>
      window.vibe.chat.onEvent((_projectId, event) => {
        if (event.type === 'turn_complete') refresh(true)
      }),
    [refresh]
  )

  return (
    <div className="usage-meters">
      {CLIS.filter(({ cli }) => statuses[cli].status === 'logged_in').map(({ cli, name }) => {
        const snapshot = usage[cli]
        const tooltip = !snapshot
          ? `Checking ${name} usage…`
          : snapshot.status !== 'ok'
            ? `${name} usage unavailable${snapshot.message ? `: ${snapshot.message}` : ''}`
            : [
                `${name}${snapshot.plan ? ` (${snapshot.plan} plan)` : ''}`,
                ...snapshot.windows.map(
                  (w) => `${w.label}: ${Math.round(w.usedPercent)}% used, ${formatReset(w.resetsAt)}`
                ),
                'Click to refresh'
              ].join('\n')
        return (
          <button key={cli} className="usage-meter" title={tooltip} onClick={() => refresh(true)}>
            <span className="usage-meter-name">{name}</span>
            <span className="usage-meter-bars">
              {snapshot?.status === 'ok' ? (
                snapshot.windows.map((w) => {
                  const left = Math.max(0, 100 - Math.round(w.usedPercent))
                  return (
                    <span key={w.label} className={`usage-bar-row ${levelClass(w.usedPercent)}`}>
                      <span className="usage-bar-label">{w.label === '5-hour' ? '5h' : w.label === 'Weekly' ? 'wk' : w.label}</span>
                      <span className="usage-bar">
                        <span className="usage-bar-fill" style={{ width: `${left}%` }} />
                      </span>
                      <span className="usage-bar-value">{left}%</span>
                    </span>
                  )
                })
              ) : (
                <span className="usage-bar-empty">{snapshot ? '—' : '…'}</span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export default UsageMeters
