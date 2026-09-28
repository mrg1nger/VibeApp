import { useCallback, useState } from 'react'

interface GoNutzToggleProps {
  enabled: boolean
  onChange: (enabled: boolean) => Promise<void>
}

function GoNutzToggle({ enabled, onChange }: GoNutzToggleProps) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleClick = useCallback(() => {
    if (enabled) {
      setBusy(true)
      onChange(false).finally(() => setBusy(false))
    } else {
      setConfirming(true)
    }
  }, [enabled, onChange])

  const handleConfirmEnable = useCallback(() => {
    setBusy(true)
    onChange(true)
      .then(() => setConfirming(false))
      .finally(() => setBusy(false))
  }, [onChange])

  return (
    <div className="go-nutz-control">
      <button
        className={`go-nutz-button ${enabled ? 'go-nutz-active' : ''}`}
        onClick={handleClick}
        disabled={busy}
      >
        {enabled ? '🔥 Go Nutz: ON' : 'Go Nutz'}
      </button>

      {confirming && (
        <div className="go-nutz-modal-overlay" onClick={() => setConfirming(false)}>
          <div className="go-nutz-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Turn on Go Nutz mode?</h3>
            <p>
              Claude and Codex will run with <strong>no confirmation prompts and no sandbox</strong>{' '}
              for this project. Every shell command, file change, and delegated Codex subtask
              executes immediately, including ones that would normally be blocked (e.g.{' '}
              <code>rm -rf</code>, <code>git push --force</code>).
            </p>
            <p>Only turn this on for a project and task you trust completely.</p>
            <div className="go-nutz-modal-actions">
              <button onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
              <button className="go-nutz-confirm" onClick={handleConfirmEnable} disabled={busy}>
                Yes, go nutz
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default GoNutzToggle
