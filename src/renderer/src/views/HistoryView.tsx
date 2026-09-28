import { useCallback, useEffect, useState } from 'react'
import type { CheckpointRecord, ProjectRecord } from '@shared/types'

interface HistoryViewProps {
  project: ProjectRecord
  onBack: () => void
}

function HistoryView({ project, onBack }: HistoryViewProps) {
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [restoredBranch, setRestoredBranch] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setCheckpoints(await window.vibe.git.history(project.path))
    } finally {
      setLoading(false)
    }
  }, [project.path])

  useEffect(() => {
    load()
  }, [load])

  const handleRestore = useCallback(
    async (hash: string) => {
      setRestoring(hash)
      try {
        const branchName = await window.vibe.git.restore(project.path, hash)
        setRestoredBranch(branchName)
      } finally {
        setRestoring(null)
      }
    },
    [project.path]
  )

  return (
    <div className="history-view">
      <div className="chat-header">
        <button onClick={onBack}>&larr; Back</button>
        <span className="chat-project-name">{project.name} — History</span>
      </div>

      {restoredBranch && (
        <div className="restore-banner">
          Restored to a new branch: <code>{restoredBranch}</code>. Your working folder now reflects
          that checkpoint; later checkpoints are still safe on the previous branch.
        </div>
      )}

      {loading && <p>Loading history…</p>}

      {!loading && checkpoints.length === 0 && <p>No checkpoints yet.</p>}

      <ul className="checkpoint-list">
        {checkpoints.map((cp) => (
          <li key={cp.hash} className="checkpoint-row">
            <div className="checkpoint-info">
              <span className="checkpoint-message">{cp.message}</span>
              <span className="checkpoint-meta">
                {new Date(cp.date).toLocaleString()} · {cp.hash.slice(0, 8)}
              </span>
            </div>
            <button onClick={() => handleRestore(cp.hash)} disabled={restoring === cp.hash}>
              {restoring === cp.hash ? 'Restoring…' : 'Restore'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default HistoryView
