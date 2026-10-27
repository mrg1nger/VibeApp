import { useCallback, useEffect, useState } from 'react'
import type { GitHubSync, ProjectRecord, PublishStatus } from '@shared/types'
import Modal from './Modal'
import LoginTerminal from './LoginTerminal'

interface PublishDialogProps {
  project: ProjectRecord
  onClose: () => void
  onError: (message: string) => void
  /** Ask Claude to move leaked secrets out of the files. */
  onFixLeaks: (message: string) => void
}

type Terminal = { sessionId: string; purpose: 'gh-install' | 'gh-login' | 'vercel-login' | 'vercel' }

function repoNameFor(project: ProjectRecord): string {
  return project.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-app'
}

function PublishDialog({ project, onClose, onError, onFixLeaks }: PublishDialogProps) {
  const [status, setStatus] = useState<PublishStatus | null>(null)
  const [terminal, setTerminal] = useState<Terminal | null>(null)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [repoName, setRepoName] = useState(repoNameFor(project))
  const [visibility, setVisibility] = useState<'private' | 'public'>('private')
  const [pushing, setPushing] = useState(false)
  const [deployFailed, setDeployFailed] = useState(false)
  const [justPublished, setJustPublished] = useState<{ vercel?: string; github?: string }>({})

  const [sync, setSync] = useState<GitHubSync | null>(null)

  const refresh = useCallback(() => {
    window.vibe.publish
      .status(project.id, project.path)
      .then(setStatus)
      .catch((err: Error) => onError(err.message))
    window.vibe.github
      .status(project.id, project.path, false)
      .then(setSync)
      .catch(() => undefined)
  }, [project.id, project.path, onError])

  useEffect(() => {
    refresh()
  }, [refresh])

  const startTerminal = useCallback(
    async (purpose: Terminal['purpose'], start: () => Promise<string>) => {
      setDeployFailed(false)
      try {
        setTerminal({ sessionId: await start(), purpose })
      } catch (err) {
        onError((err as Error).message)
      }
    },
    [onError]
  )

  const deploy = useCallback(
    () => startTerminal('vercel', () => window.vibe.publish.vercel(project.id, project.path, includeSecrets)),
    [startTerminal, project.id, project.path, includeSecrets]
  )

  const handleTerminalExit = useCallback(async (exitCode: number) => {
    const finished = terminal
    if (!finished) return
    if (finished.purpose === 'vercel-login') {
      if (exitCode === 0) {
        deploy() // signed in: carry straight on with the deploy
      } else {
        setDeployFailed(true)
      }
      return
    }
    if (finished.purpose === 'vercel') {
      const url = await window.vibe.publish.vercelResult(finished.sessionId)
      if (url) {
        setJustPublished((prev) => ({ ...prev, vercel: url }))
        setTerminal(null)
      } else {
        setDeployFailed(true) // keep the output on screen so the error is visible
      }
    } else {
      setTerminal(null)
    }
    refresh()
  }, [terminal, refresh, deploy])

  const handleGitHub = useCallback(async () => {
    setPushing(true)
    try {
      const url = await window.vibe.publish.github(project.id, project.path, { name: repoName, visibility })
      setJustPublished((prev) => ({ ...prev, github: url }))
      refresh()
    } catch (err) {
      onError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setPushing(false)
    }
  }, [project.id, project.path, repoName, visibility, refresh, onError])

  const leaks = status?.leaks ?? []
  const blocked = leaks.length > 0
  const vercelUrl = justPublished.vercel ?? status?.deployUrl ?? null
  const githubUrl = justPublished.github ?? status?.githubUrl ?? null

  return (
    <Modal title="Publish" onClose={onClose} wide>
      {!status && <p className="modal-muted">Checking your project…</p>}

      {blocked && (
        <div className="publish-blocked">
          <strong>🔑 Found secret keys in your files.</strong> Publishing would expose them, so it’s turned off
          until they’re moved into Secrets.
          <pre>{leaks.slice(0, 8).map((l) => `${l.file}:${l.line}  (${l.what})`).join('\n')}</pre>
          <button
            onClick={() =>
              onFixLeaks(
                `Secret keys are written into project files:\n${leaks
                  .slice(0, 20)
                  .map((l) => `- ${l.file}:${l.line} (${l.what})`)
                  .join('\n')}\nMove them out: read each from an environment variable instead and delete the value from the file. Tell me the names so I can add any that aren't in VibeApp's Secrets panel yet.`
              )
            }
          >
            Ask Claude to fix it
          </button>
        </div>
      )}

      {terminal && (
        <div className="publish-terminal">
          <p className="modal-muted">
            {terminal.purpose === 'vercel-login'
              ? 'Signing in to Vercel (free): your browser should open to the sign-in page. Approve it there and publishing continues by itself. If the browser didn’t open, use the link below.'
              : terminal.purpose === 'vercel'
                ? 'Publishing your app…'
                : terminal.purpose === 'gh-login'
                ? 'Signing in to GitHub: press Enter to open your browser, then enter the code shown.'
                : 'Installing the GitHub app…'}
          </p>
          <LoginTerminal sessionId={terminal.sessionId} onExit={handleTerminalExit} api={window.vibe.install} />
          {deployFailed && (
            <div className="publish-actions">
              <span className="modal-muted">
                {terminal.purpose === 'vercel-login'
                  ? 'Sign-in didn’t finish. You can close this and try again.'
                  : 'The deploy didn’t finish. The output above says why.'}
              </span>
              <button onClick={() => setTerminal(null)}>Close</button>
            </div>
          )}
        </div>
      )}

      {status && !terminal && (
        <div className="publish-options">
          <section className="publish-card">
            <h4>🌐 Share a live link</h4>
            <p className="modal-muted">
              Puts your app online at a public web address with Vercel. Anyone with the link can open it.
            </p>
            {vercelUrl && (
              <p className="publish-link">
                Live at{' '}
                <a href={vercelUrl} target="_blank" rel="noreferrer">
                  {vercelUrl}
                </a>
                <button onClick={() => navigator.clipboard.writeText(vercelUrl)}>Copy</button>
              </p>
            )}
            {status.secretNames.length > 0 && (
              <label className="publish-check">
                <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
                <span>
                  Give the live app my secrets ({status.secretNames.join(', ')})
                  <small>
                    Needed if the app calls those services. They’re sent to Vercel, and anything the app shows in the
                    browser is visible to visitors.
                  </small>
                </span>
              </label>
            )}
            {!status.nodeInstalled ? (
              <p className="modal-muted">Node.js is needed to publish. Install it from the Accounts tab.</p>
            ) : (
              <button
                className="publish-primary"
                disabled={blocked}
                onClick={() => (status.vercelLoggedIn ? deploy() : startTerminal('vercel-login', window.vibe.publish.vercelLogin))}
              >
                {!status.vercelLoggedIn ? 'Sign in to Vercel & publish' : vercelUrl ? 'Publish update' : 'Publish'}
              </button>
            )}
          </section>

          <section className="publish-card">
            <h4>💾 Back up to GitHub</h4>
            <p className="modal-muted">
              Saves your project and all its checkpoints to your GitHub account, so it’s safe off this computer.
            </p>
            {githubUrl && (
              <p className="publish-link">
                Backed up to{' '}
                <a href={githubUrl} target="_blank" rel="noreferrer">
                  {githubUrl.replace('https://github.com/', '')}
                </a>
              </p>
            )}
            {!status.ghInstalled ? (
              <button
                className="publish-primary"
                onClick={() => startTerminal('gh-install', window.vibe.publish.ghInstall)}
              >
                Install GitHub app
              </button>
            ) : !status.ghLoggedIn ? (
              <button className="publish-primary" onClick={() => startTerminal('gh-login', window.vibe.publish.ghLogin)}>
                Sign in to GitHub
              </button>
            ) : (
              <>
                {!githubUrl && (
                  <div className="publish-fields">
                    <input value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="Repository name" />
                    <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'public')}>
                      <option value="private">Private (only you)</option>
                      <option value="public">Public (anyone can see the code)</option>
                    </select>
                  </div>
                )}
                <button className="publish-primary" disabled={blocked || pushing} onClick={handleGitHub}>
                  {pushing ? 'Backing up…' : githubUrl ? 'Back up latest changes' : 'Create repository & back up'}
                </button>
              </>
            )}
            {githubUrl && sync?.linked && (
              <>
                <label className="publish-check">
                  <input
                    type="checkbox"
                    checked={sync.autoBackup}
                    onChange={async (e) => {
                      const next = await window.vibe.github.setAutoBackup(project.id, e.target.checked).catch(() => null)
                      if (next) setSync(next)
                    }}
                  />
                  <span>
                    Back up automatically after each request
                    <small>
                      Uploads when Claude or Codex finishes, so GitHub always has the latest. It also keeps your other
                      computer in step: open the project there and VibeApp offers the newer work.
                    </small>
                  </span>
                </label>
                {(sync.problem || sync.lastBackupAt) && (
                  <p className="github-sync-line">
                    {sync.problem
                      ? `Last backup didn't go: ${sync.problem}`
                      : `Last backed up at ${new Date(sync.lastBackupAt!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`}
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </Modal>
  )
}

export default PublishDialog
