import { useCallback, useEffect, useState } from 'react'
import type { MemoryFact, MemoryScope, ProjectRecord } from '@shared/types'

interface MemoryViewProps {
  project: ProjectRecord | null
}

const SOURCE_LABELS: Record<MemoryFact['source'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  user: 'You'
}

function MemoryView({ project }: MemoryViewProps) {
  const [scope, setScope] = useState<MemoryScope>('project')
  const [facts, setFacts] = useState<MemoryFact[]>([])
  const [loading, setLoading] = useState(true)
  const [newFact, setNewFact] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')

  const effectiveScope: MemoryScope = project ? scope : 'global'

  const refresh = useCallback(() => {
    // A stable id is required for project-scoped storage; global scope
    // doesn't need one, so pass a placeholder that's never read for it.
    const projectId = project?.id ?? 'none'
    setLoading(true)
    window.vibe.memory
      .list(projectId, effectiveScope)
      .then(setFacts)
      .finally(() => setLoading(false))
  }, [project?.id, effectiveScope])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleAdd = useCallback(async () => {
    const text = newFact.trim()
    if (!text) return
    const projectId = project?.id ?? 'none'
    await window.vibe.memory.add(projectId, effectiveScope, text)
    setNewFact('')
    refresh()
  }, [newFact, project?.id, effectiveScope, refresh])

  const handleDelete = useCallback(
    async (id: string) => {
      const projectId = project?.id ?? 'none'
      await window.vibe.memory.delete(projectId, effectiveScope, id)
      refresh()
    },
    [project?.id, effectiveScope, refresh]
  )

  const handleStartEdit = useCallback((fact: MemoryFact) => {
    setEditingId(fact.id)
    setEditingText(fact.text)
  }, [])

  const handleSaveEdit = useCallback(async () => {
    if (!editingId) return
    const projectId = project?.id ?? 'none'
    await window.vibe.memory.update(projectId, effectiveScope, editingId, editingText.trim())
    setEditingId(null)
    refresh()
  }, [editingId, editingText, project?.id, effectiveScope, refresh])

  return (
    <div className="memory-view">
      <h2>Memory</h2>

      {project && (
        <div className="memory-scope-tabs">
          <button className={scope === 'project' ? 'active' : ''} onClick={() => setScope('project')}>
            This project: {project.name}
          </button>
          <button className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')}>
            Global (all projects)
          </button>
        </div>
      )}
      {!project && <p className="memory-hint">Open a project to see its project-scoped memory too.</p>}

      <div className="memory-add-row">
        <input
          value={newFact}
          onChange={(e) => setNewFact(e.target.value)}
          placeholder={`Add a fact to ${effectiveScope === 'global' ? 'global' : 'this project'} memory…`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
        />
        <button onClick={handleAdd} disabled={!newFact.trim()}>
          Add
        </button>
      </div>

      {loading && <p>Loading…</p>}
      {!loading && facts.length === 0 && <p className="memory-hint">Nothing remembered here yet.</p>}

      <ul className="memory-list">
        {facts.map((fact) => (
          <li key={fact.id} className="memory-row">
            {editingId === fact.id ? (
              <input
                className="memory-edit-input"
                value={editingText}
                onChange={(e) => setEditingText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveEdit()
                  if (e.key === 'Escape') setEditingId(null)
                }}
                autoFocus
              />
            ) : (
              <span className="memory-text">{fact.text}</span>
            )}
            <span className="memory-meta">
              {SOURCE_LABELS[fact.source]} · {new Date(fact.createdAt).toLocaleDateString()}
            </span>
            <div className="memory-row-actions">
              {editingId === fact.id ? (
                <button onClick={handleSaveEdit}>Save</button>
              ) : (
                <button onClick={() => handleStartEdit(fact)}>Edit</button>
              )}
              <button onClick={() => handleDelete(fact.id)}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default MemoryView
