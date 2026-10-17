import { useCallback, useEffect, useState } from 'react'
import Modal from './Modal'

interface FolderBrowserProps {
  /** 'open' picks an existing folder; 'create' picks where to make a new one and names it. */
  purpose: 'open' | 'create'
  onChoose: (folder: string, newName?: string) => Promise<void>
  onClose: () => void
}

/**
 * Browses folders on the computer running VibeApp. Used in a web browser
 * (Remote access), where the desktop app's folder dialogs aren't available.
 */
function FolderBrowser({ purpose, onChoose, onClose }: FolderBrowserProps) {
  const [path, setPath] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const go = useCallback((dir?: string) => {
    setError('')
    window.vibe.fs
      .listDirs(dir)
      .then((r) => {
        setPath(r.path)
        setParent(r.parent)
        setDirs(r.dirs)
      })
      .catch((err: Error) => setError(err.message))
  }, [])

  useEffect(() => go(), [go])

  const choose = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await onChoose(path, purpose === 'create' ? name.trim() : undefined)
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={purpose === 'open' ? 'Open a folder' : 'Create a new project'} onClose={onClose} wide>
      <p className="modal-muted">Folders on the computer running VibeApp.</p>
      <div className="folder-path">{path || 'Choose a place to start'}</div>
      <ul className="folder-list">
        {parent !== null && (
          <li>
            <button onClick={() => go(parent || undefined)}>⬆ Up</button>
          </li>
        )}
        {dirs.map((d) => (
          <li key={d.path}>
            <button onClick={() => go(d.path)}>📁 {d.name}</button>
          </li>
        ))}
        {path && dirs.length === 0 && <li className="modal-muted">No folders in here.</li>}
      </ul>
      {purpose === 'create' && path && (
        <label className="settings-field">
          New project folder name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-game" />
        </label>
      )}
      {error && <p className="chat-error">{error}</p>}
      <div className="modal-actions">
        <button onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className="modal-primary"
          onClick={choose}
          disabled={busy || !path || (purpose === 'create' && !name.trim())}
        >
          {purpose === 'open' ? 'Open this folder' : `Create "${name.trim() || '…'}" here`}
        </button>
      </div>
    </Modal>
  )
}

export default FolderBrowser
