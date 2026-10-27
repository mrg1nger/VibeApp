import { useCallback, useEffect, useState } from 'react'
import type { ProjectRecord } from '@shared/types'
import Modal from '../components/Modal'
import FolderBrowser from '../components/FolderBrowser'
import GitHubOpenDialog from '../components/GitHubOpenDialog'

// In a browser (Remote access) there are no folder dialogs; folders are browsed on the computer instead.
const inBrowser = window.vibe.host === 'browser'

interface ProjectPickerViewProps {
  onOpen: (project: ProjectRecord) => void
  onError: (message: string) => void
  /** A project was taken off the list. */
  onRemoved?: (projectId: string) => void
}

function ProjectPickerView({ onOpen, onError, onRemoved }: ProjectPickerViewProps) {
  const [recent, setRecent] = useState<ProjectRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<ProjectRecord | null>(null)
  const [browsing, setBrowsing] = useState<'open' | 'create' | null>(null)
  const [fromGitHub, setFromGitHub] = useState(false)

  useEffect(() => {
    window.vibe.project.list().then(setRecent)
  }, [])

  const handlePickExisting = useCallback(async () => {
    if (inBrowser) return setBrowsing('open')
    setBusy(true)
    try {
      const project = await window.vibe.project.pickExisting()
      if (project) onOpen(project)
    } catch (err) {
      onError(`Couldn't open that folder: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [onOpen, onError])

  const handleCreateNew = useCallback(async () => {
    if (inBrowser) return setBrowsing('create')
    setBusy(true)
    try {
      const project = await window.vibe.project.pickNewFolder()
      if (project) onOpen(project)
    } catch (err) {
      onError(`Couldn't create that project: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [onOpen, onError])

  const handleRemove = useCallback(
    async (project: ProjectRecord, erase: boolean) => {
      setBusy(true)
      try {
        setRecent(await window.vibe.project.remove(project.id, erase))
        onRemoved?.(project.id)
        setRemoving(null)
      } catch (err) {
        onError(`Couldn't remove that project: ${(err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
      } finally {
        setBusy(false)
      }
    },
    [onRemoved, onError]
  )

  return (
    <div className="project-picker">
      {browsing && (
        <FolderBrowser
          purpose={browsing}
          onClose={() => setBrowsing(null)}
          onChoose={async (folder, newName) => {
            const project = newName
              ? await window.vibe.project.createFolder(folder, newName)
              : await window.vibe.project.openFolder(folder)
            setBrowsing(null)
            onOpen(project)
          }}
        />
      )}
      <h2>Projects</h2>
      <div className="project-actions">
        <button onClick={handlePickExisting} disabled={busy}>
          Open a folder
        </button>
        <button onClick={handleCreateNew} disabled={busy}>
          Create a new project
        </button>
        <button onClick={() => setFromGitHub(true)} disabled={busy}>
          Get a project from GitHub
        </button>
      </div>
      {fromGitHub && (
        <GitHubOpenDialog
          onClose={() => setFromGitHub(false)}
          onOpen={(project) => {
            setFromGitHub(false)
            onOpen(project)
          }}
        />
      )}

      {recent.length > 0 && (
        <div className="recent-projects">
          <h3>Recent</h3>
          <ul>
            {recent.map((project) => (
              <li key={project.id} className="project-item">
                <button className="project-row" onClick={() => onOpen(project)}>
                  <span className="project-name">{project.name}</span>
                  <span className="project-path">{project.path}</span>
                </button>
                <button
                  className="project-remove"
                  title="Remove from this list (your folder and files aren't touched)"
                  aria-label={`Remove ${project.name} from the list`}
                  onClick={() => setRemoving(project)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {removing && (
        <Modal title={`Remove “${removing.name}”?`} onClose={() => setRemoving(null)}>
          <p className="modal-text">
            This only takes it off this list. Your project folder and everything in it stays exactly where it is:
          </p>
          <p className="modal-muted">{removing.path}</p>
          <div className="remove-choices">
            <button className="modal-primary" disabled={busy} onClick={() => handleRemove(removing, false)}>
              Remove from list
              <small>Keeps its chat history and memory. They come back if you add the folder again.</small>
            </button>
            <button className="remove-erase" disabled={busy} onClick={() => handleRemove(removing, true)}>
              Remove and erase VibeApp&apos;s data for it
              <small>
                Also deletes its chat history, memory, saved secrets and attached images. This can&apos;t be undone.
              </small>
            </button>
          </div>
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setRemoving(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

export default ProjectPickerView
