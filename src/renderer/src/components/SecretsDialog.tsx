import { useCallback, useEffect, useState } from 'react'
import type { SecretSummary } from '@shared/types'
import Modal from './Modal'

interface SecretsDialogProps {
  projectId: string
  onClose: () => void
  onError: (message: string) => void
}

function SecretsDialog({ projectId, onClose, onError }: SecretsDialogProps) {
  const [secrets, setSecrets] = useState<SecretSummary[]>([])
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(() => {
    window.vibe.secrets
      .list(projectId)
      .then(setSecrets)
      .catch((err: Error) => onError(err.message))
  }, [projectId, onError])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleAdd = useCallback(async () => {
    if (!name.trim() || !value.trim()) return
    setSaving(true)
    try {
      await window.vibe.secrets.set(projectId, name, value)
      setName('')
      setValue('')
      refresh()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [projectId, name, value, refresh, onError])

  const handleDelete = useCallback(
    async (secretName: string) => {
      try {
        await window.vibe.secrets.delete(projectId, secretName)
        refresh()
      } catch (err) {
        onError((err as Error).message)
      }
    },
    [projectId, refresh, onError]
  )

  return (
    <Modal title="🔑 Secrets" onClose={onClose}>
      <p className="modal-text">
        API keys and passwords for this project. They're stored encrypted on this computer, never in your
        project files, git history, or the chat. Your app gets them as environment variables; Claude only
        sees their names.
      </p>

      {secrets.length === 0 ? (
        <p className="modal-muted">No secrets yet.</p>
      ) : (
        <ul className="secret-list">
          {secrets.map((s) => (
            <li key={s.name}>
              <code>{s.name}</code>
              <span className="modal-muted">{s.preview}</span>
              <button onClick={() => handleDelete(s.name)}>Delete</button>
            </li>
          ))}
        </ul>
      )}

      <div className="secret-add">
        <input
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
          placeholder="NAME, e.g. OPENAI_API_KEY"
          spellCheck={false}
        />
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Value"
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
        />
        <button onClick={handleAdd} disabled={saving || !name.trim() || !value.trim()}>
          Save
        </button>
      </div>
      <p className="modal-muted">
        Changing a secret restarts the preview and refreshes Claude’s session so both pick it up.
      </p>
    </Modal>
  )
}

export default SecretsDialog
