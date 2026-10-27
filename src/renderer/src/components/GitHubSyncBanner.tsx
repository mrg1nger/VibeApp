import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitHubSync, ProjectRecord } from '@shared/types'

interface GitHubSyncBannerProps {
  project: ProjectRecord
  busy: boolean
  /** Sends a request to Claude (to combine both computers' work). */
  onAskClaude: (text: string) => void
  onError: (message: string) => void
}

const CHECK_EVERY_MS = 10 * 60_000
const FOCUS_RECHECK_MS = 2 * 60_000

const clean = (err: unknown): string => String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * Shown when GitHub has newer work for this project than this computer (made
 * on the user's other computer): get it, and if both changed the same lines,
 * choose how to combine them. Hidden the rest of the time.
 */
function GitHubSyncBanner({ project, busy, onAskClaude, onError }: GitHubSyncBannerProps) {
  const [sync, setSync] = useState<GitHubSync | null>(null)
  const [conflict, setConflict] = useState<string[] | null>(null)
  const [working, setWorking] = useState(false)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const lastFetch = useRef(0)

  const check = useCallback(
    (fetch: boolean) => {
      if (fetch) lastFetch.current = Date.now()
      window.vibe.github
        .status(project.id, project.path, fetch)
        .then(setSync)
        .catch(() => undefined)
    },
    [project.id, project.path]
  )

  useEffect(() => {
    setSync(null)
    setConflict(null)
    setDismissedAt(null)
    check(true)
    const timer = setInterval(() => check(true), CHECK_EVERY_MS)
    const onFocus = (): void => {
      if (Date.now() - lastFetch.current > FOCUS_RECHECK_MS) check(true)
    }
    window.addEventListener('focus', onFocus)
    const off = window.vibe.github.onChanged((id) => id === project.id && check(false))
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      off()
    }
  }, [check, project.id])

  const getIt = async (): Promise<void> => {
    setWorking(true)
    try {
      const result = await window.vibe.github.getLatest(project.id, project.path)
      if (result.status === 'conflict') setConflict(result.files)
      check(false)
    } catch (err) {
      onError(`Couldn't get the newer work from GitHub: ${clean(err)}`)
    } finally {
      setWorking(false)
    }
  }

  const useGitHubs = async (): Promise<void> => {
    setWorking(true)
    try {
      await window.vibe.github.useGitHubVersion(project.id, project.path)
      setConflict(null)
      check(false)
    } catch (err) {
      onError(`Couldn't switch to GitHub's version: ${clean(err)}`)
    } finally {
      setWorking(false)
    }
  }

  if (conflict) {
    const files = conflict.slice(0, 6).join(', ') + (conflict.length > 6 ? ` and ${conflict.length - 6} more` : '')
    return (
      <div className="github-banner github-banner-conflict" role="status">
        <div>
          <strong>Both computers changed the same parts of {conflict.length === 1 ? 'a file' : 'some files'}:</strong> {files}. Nothing
          has been changed here yet. How should they be combined?
        </div>
        <div className="github-banner-actions">
          <button
            className="github-banner-primary"
            disabled={busy || working}
            onClick={() => {
              setConflict(null)
              onAskClaude(
                `The work on GitHub (from my other computer) and the work on this computer both changed the same parts of: ${conflict.join(', ')}. Bring in GitHub's work with \`git fetch origin\` and \`git merge origin/${sync?.branch ?? 'main'}\`, then resolve the conflicts so both sides' changes are kept (ask me if they really contradict each other), check the project still works, and commit the merge. Then tell me in plain words what each side had changed.`
              )
            }}
          >
            Ask Claude to combine them
          </button>
          <button
            disabled={busy || working}
            title="This computer's version is kept on its own branch, here and on GitHub"
            onClick={useGitHubs}
          >
            Use GitHub&apos;s version
          </button>
          <button disabled={working} onClick={() => setConflict(null)}>
            Not now
          </button>
        </div>
      </div>
    )
  }

  if (!sync?.linked || sync.behind === 0 || dismissedAt === sync.behind) return null
  const n = sync.behind
  const incoming = (sync.incoming ?? []).slice(0, 3)
  return (
    <div className="github-banner" role="status">
      <div>
        <strong>
          ⬇ GitHub has {n} newer checkpoint{n === 1 ? '' : 's'} for this project
        </strong>
        , probably from your other computer
        {incoming.length > 0 && <>: {incoming.map((m) => `“${m}”`).join(', ')}{n > incoming.length ? '…' : ''}</>}.
        {(sync.ahead > 0 || sync.dirty) && ' Your changes on this computer are kept and combined with them.'}
      </div>
      <div className="github-banner-actions">
        <button className="github-banner-primary" disabled={busy || working} onClick={getIt}>
          {working ? 'Getting it…' : 'Get it'}
        </button>
        <button disabled={working} onClick={() => setDismissedAt(n)}>
          Not now
        </button>
      </div>
    </div>
  )
}

export default GitHubSyncBanner
