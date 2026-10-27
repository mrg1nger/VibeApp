import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitHubRepoInfo, ProjectRecord } from '@shared/types'
import Modal from './Modal'
import LoginTerminal from './LoginTerminal'
import FolderBrowser from './FolderBrowser'

interface GitHubOpenDialogProps {
  onOpen: (project: ProjectRecord) => void
  onClose: () => void
}

// In a browser (Remote access) there are no folder dialogs; folders are browsed on the computer instead.
const inBrowser = window.vibe.host === 'browser'

const clean = (err: unknown): string => String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Downloads one of the user's GitHub repositories as a new project (or a project from another computer). */
function GitHubOpenDialog({ onOpen, onClose }: GitHubOpenDialogProps) {
  const [account, setAccount] = useState<{ ghInstalled: boolean; loggedIn: boolean; login?: string } | null>(null)
  const [terminal, setTerminal] = useState<{ sessionId: string; purpose: 'install' | 'login' } | null>(null)
  const [repos, setRepos] = useState<GitHubRepoInfo[] | null>(null)
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState('')
  const [folder, setFolder] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadAccount = useCallback(() => {
    setAccount(null)
    window.vibe.github
      .account()
      .then(setAccount)
      .catch((err) => setError(clean(err)))
  }, [])

  useEffect(() => {
    loadAccount()
    window.vibe.github.defaultFolder().then(setFolder).catch(() => undefined)
  }, [loadAccount])

  useEffect(() => {
    if (!account?.loggedIn) return
    window.vibe.github
      .repos()
      .then(setRepos)
      .catch((err) => setError(clean(err)))
  }, [account?.loggedIn])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (repos ?? []).filter((r) => !q || r.nameWithOwner.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
  }, [repos, filter])

  // Typed as owner/name or a github.com address, when it isn't in the list.
  const typed = /^(https?:\/\/github\.com\/|git@github\.com:)?[\w-]+\/[\w.-]+/i.test(filter.trim()) ? filter.trim() : ''
  const repo = picked || typed

  const startTerminal = async (purpose: 'install' | 'login'): Promise<void> => {
    setError('')
    try {
      const sessionId = await (purpose === 'install' ? window.vibe.publish.ghInstall() : window.vibe.publish.ghLogin())
      setTerminal({ sessionId, purpose })
    } catch (err) {
      setError(clean(err))
    }
  }

  const changeFolder = async (): Promise<void> => {
    if (inBrowser) return setBrowsing(true)
    const chosen = await window.vibe.github.pickFolder().catch(() => null)
    if (chosen) setFolder(chosen)
  }

  const download = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      onOpen(await window.vibe.github.clone(repo, folder))
    } catch (err) {
      setError(clean(err))
    } finally {
      setBusy(false)
    }
  }

  if (browsing) {
    return (
      <FolderBrowser
        purpose="open"
        onClose={() => setBrowsing(false)}
        onChoose={async (chosen) => {
          setFolder(chosen)
          setBrowsing(false)
        }}
      />
    )
  }

  const name = repo.replace(/\.git$/, '').split(/[/:]/).pop() ?? ''
  return (
    <Modal title="Get a project from GitHub" onClose={onClose} wide>
      {terminal ? (
        <div className="publish-terminal">
          <p className="modal-muted">
            {terminal.purpose === 'login'
              ? 'Signing in to GitHub: press Enter to open your browser, then enter the code shown.'
              : 'Installing the GitHub app…'}
          </p>
          <LoginTerminal
            sessionId={terminal.sessionId}
            api={window.vibe.install}
            onExit={() => {
              setTerminal(null)
              loadAccount()
            }}
          />
        </div>
      ) : !account ? (
        <p className="modal-muted">{error || 'Checking GitHub…'}</p>
      ) : !account.ghInstalled ? (
        <>
          <p className="modal-text">VibeApp uses GitHub&apos;s own small app to download your projects. It installs in a minute.</p>
          <div className="modal-actions">
            <button className="modal-primary" onClick={() => startTerminal('install')}>
              Install GitHub app
            </button>
          </div>
        </>
      ) : !account.loggedIn ? (
        <>
          <p className="modal-text">Sign in to GitHub to see your repositories.</p>
          <div className="modal-actions">
            <button className="modal-primary" onClick={() => startTerminal('login')}>
              Sign in to GitHub
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="modal-muted">
            Your repositories{account.login ? ` on ${account.login}` : ''}. Pick one to download it here and open it as a
            project. It keeps itself backed up to GitHub after each request (you can turn that off in Publish).
          </p>
          <input
            className="github-filter"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              setPicked('')
            }}
            placeholder="Search, or type owner/name"
            aria-label="Search your repositories"
          />
          {!repos ? (
            <p className="modal-muted">{error ? '' : 'Loading your repositories…'}</p>
          ) : shown.length === 0 ? (
            <p className="modal-muted">{typed ? `Not in your list: it will download ${typed}.` : 'No repositories match.'}</p>
          ) : (
            <ul className="github-repo-list">
              {shown.slice(0, 100).map((r) => (
                <li key={r.nameWithOwner}>
                  <button className={picked === r.nameWithOwner ? 'active' : ''} onClick={() => setPicked(r.nameWithOwner)}>
                    <span>
                      {r.nameWithOwner} {r.private ? '🔒' : ''}
                    </span>
                    <small>
                      {r.description ? `${r.description} · ` : ''}changed {new Date(r.updatedAt).toLocaleDateString()}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="github-folder">
            <span>
              Put it in: <strong>{folder || '…'}</strong>
              {name && folder ? ` (as the folder "${name}")` : ''}
            </span>
            <button onClick={changeFolder}>Change…</button>
          </div>
        </>
      )}
      {error && account && <p className="chat-error">{error}</p>}
      {account?.loggedIn && !terminal && (
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="modal-primary" disabled={busy || !repo || !folder} onClick={download}>
            {busy ? 'Downloading…' : 'Download & open'}
          </button>
        </div>
      )}
    </Modal>
  )
}

export default GitHubOpenDialog
