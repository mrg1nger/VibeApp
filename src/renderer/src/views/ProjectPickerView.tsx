import { useCallback, useEffect, useState } from 'react'
import type { ProjectRecord } from '@shared/types'

interface ProjectPickerViewProps {
  onOpen: (project: ProjectRecord) => void
  onError: (message: string) => void
}

function ProjectPickerView({ onOpen, onError }: ProjectPickerViewProps) {
  const [recent, setRecent] = useState<ProjectRecord[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.vibe.project.list().then(setRecent)
  }, [])

  const handlePickExisting = useCallback(async () => {
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

  return (
    <div className="project-picker">
      <h2>Projects</h2>
      <div className="project-actions">
        <button onClick={handlePickExisting} disabled={busy}>
          Open a folder
        </button>
        <button onClick={handleCreateNew} disabled={busy}>
          Create a new project
        </button>
      </div>

      {recent.length > 0 && (
        <div className="recent-projects">
          <h3>Recent</h3>
          <ul>
            {recent.map((project) => (
              <li key={project.id}>
                <button className="project-row" onClick={() => onOpen(project)}>
                  <span className="project-name">{project.name}</span>
                  <span className="project-path">{project.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default ProjectPickerView
