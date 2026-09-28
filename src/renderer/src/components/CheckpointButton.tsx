import { useCallback, useState } from 'react'

interface CheckpointButtonProps {
  hasChanges: boolean
  onCheckpoint: (message: string) => Promise<void>
  suggestMessage: () => Promise<string>
}

function CheckpointButton({ hasChanges, onCheckpoint, suggestMessage }: CheckpointButtonProps) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const handleOpen = useCallback(async () => {
    const suggested = await suggestMessage()
    setMessage(suggested)
    setOpen(true)
  }, [suggestMessage])

  const handleConfirm = useCallback(async () => {
    if (!message.trim()) return
    setBusy(true)
    try {
      await onCheckpoint(message.trim())
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }, [message, onCheckpoint])

  return (
    <div className="checkpoint-control">
      <button className={hasChanges ? 'checkpoint-badge' : ''} onClick={handleOpen}>
        Checkpoint{hasChanges ? ' •' : ''}
      </button>

      {open && (
        <div className="checkpoint-modal-overlay" onClick={() => setOpen(false)}>
          <div className="checkpoint-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Save checkpoint</h3>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirm()
              }}
            />
            <div className="checkpoint-modal-actions">
              <button onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button onClick={handleConfirm} disabled={busy || !message.trim()}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default CheckpointButton
