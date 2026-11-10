import { execFile } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { GitHubGetResult, GitHubRepoInfo, GitHubSync } from '@shared/types'
import { isCliOnPath } from '../cli/execCli'
import { checkpoint, ensureIdentity, hasUncommittedChanges } from '../git/repo'
import { getProject, setGitHubLastBackup } from '../projects/store'
import { describeLeaks, scanDiff, scanProject } from '../secrets/leakScan'
import { secretValues } from '../secrets/vault'

// The project's copy on GitHub: uploading to it (by hand, after each request or
// on a schedule), noticing newer work there from another computer and bringing
// it in, and downloading a repository as a new project.

const execFileAsync = promisify(execFile)

/** Nothing may stop to ask for a password: there's nobody at a terminal to answer. */
const QUIET_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }

async function run(file: 'git' | 'gh', args: string[], cwd: string, timeout = 120_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, { cwd, env: QUIET_ENV, windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 })
    return stdout.trim()
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string; killed?: boolean }
    const said = `${e.stderr ?? ''}\n${e.stdout ?? ''}`.trim()
    const error = new Error(e.killed ? `${file} took too long and was stopped.` : said || e.message) as Error & { raw?: string }
    error.raw = said
    throw error
  }
}

const git = (cwd: string, args: string[], timeout?: number): Promise<string> => run('git', args, cwd, timeout)

/** The project's GitHub address (https://github.com/owner/name), or null if its origin isn't on GitHub. */
export async function githubUrl(projectPath: string): Promise<string | null> {
  // As configured (get-url would apply any insteadOf rewriting).
  const url = await git(projectPath, ['config', '--get', 'remote.origin.url']).catch(() => '')
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url)
  return m ? `https://github.com/${m[1]}/${m[2]}` : null
}

/** One git job per project at a time (a backup and "get it" must not overlap). */
const locks = new Map<string, Promise<unknown>>()
function locked<T>(projectPath: string, job: () => Promise<T>): Promise<T> {
  const key = projectPath.toLowerCase()
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(job)
  locks.set(key, next)
  void next.finally(() => {
    if (locks.get(key) === next) locks.delete(key)
  }).catch(() => undefined)
  return next
}

/** What this project last heard from GitHub (the problem: this run of VibeApp; the backup time is also saved). */
const last = new Map<string, { problem?: string; lastBackupAt?: string }>()
function note(projectId: string, patch: { problem?: string; lastBackupAt?: string }): void {
  last.set(projectId, { ...last.get(projectId), ...patch })
  // Kept with the project, so Publish still says when the last backup went up after a restart (an update restarts VibeApp).
  if (patch.lastBackupAt) setGitHubLastBackup(projectId, patch.lastBackupAt)
}

/** Short, plain words from git's output. */
export function plainGitError(err: unknown): string {
  const text = String((err as { raw?: string }).raw || (err as Error).message || err)
  if (/could not resolve host|unable to access|timed out|failed to connect|network/i.test(text)) return "Couldn't reach GitHub (is this computer online?)."
  if (/authentication failed|could not read username|permission denied|403|terminal prompts disabled/i.test(text)) {
    return 'GitHub turned this computer away: sign in to GitHub again from Publish.'
  }
  if (/repository not found/i.test(text)) return "GitHub doesn't have that repository any more (or this account can't see it)."
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^hint:/i.test(l))
  return lines.slice(-2).join(' ').slice(0, 300) || 'git failed.'
}

/** The branch being worked on (also before its first checkpoint). */
async function currentBranch(projectPath: string): Promise<string> {
  return (await git(projectPath, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')) || 'HEAD'
}

/** The branch on GitHub this one follows: its upstream, else origin/<same name>, else none yet. */
async function upstreamOf(projectPath: string, branch: string): Promise<string | null> {
  const up = await git(projectPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')
  if (up) return up
  const same = await git(projectPath, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]).catch(() => '')
  return same ? `origin/${branch}` : null
}

async function counts(projectPath: string, upstream: string | null): Promise<{ ahead: number; behind: number }> {
  if (!upstream) {
    const all = await git(projectPath, ['rev-list', '--count', 'HEAD']).catch(() => '0')
    return { ahead: Number(all) || 0, behind: 0 }
  }
  const out = await git(projectPath, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
  const [ahead, behind] = out.split(/\s+/).map((n) => Number(n) || 0)
  return { ahead, behind }
}

const fetchOrigin = (projectPath: string): Promise<string> => git(projectPath, ['fetch', '--quiet', '--prune', 'origin'], 60_000)

/** How this computer's project compares with GitHub's copy. With fetch, asks GitHub first. */
export async function syncStatus(projectId: string, projectPath: string, fetch = true): Promise<GitHubSync> {
  const autoBackup = !!getProject(projectId)?.githubAutoBackup
  const url = await githubUrl(projectPath)
  const branch = await currentBranch(projectPath)
  const saved = getProject(projectId)?.githubLastBackupAt
  const base: GitHubSync = { linked: !!url, url, branch, ahead: 0, behind: 0, dirty: false, autoBackup, ...(saved ? { lastBackupAt: saved } : {}), ...last.get(projectId) }
  if (!url) return base
  let problem = base.problem
  if (fetch) {
    try {
      await locked(projectPath, () => fetchOrigin(projectPath))
      // Reaching GitHub clears an old "couldn't reach" problem (not a blocked backup).
      if (problem && /couldn't reach|turned this computer away/i.test(problem)) problem = undefined
    } catch (err) {
      problem = plainGitError(err)
    }
    note(projectId, { problem })
  }
  const upstream = await upstreamOf(projectPath, branch)
  const { ahead, behind } = await counts(projectPath, upstream).catch(() => ({ ahead: 0, behind: 0 }))
  const dirty = await hasUncommittedChanges(projectPath).catch(() => false)
  const incoming = behind && upstream ? (await git(projectPath, ['log', '--format=%s', '-n', '8', `HEAD..${upstream}`]).catch(() => '')).split('\n').filter(Boolean) : undefined
  return { ...base, problem, ahead, behind, dirty, ...(incoming ? { incoming } : {}) }
}

/** GitHub has newer work, so this computer's upload was turned away. */
export class BehindError extends Error {
  constructor() {
    super('GitHub has newer work for this project (from another computer), so nothing was uploaded. Get it first, then the backup carries on.')
  }
}

/**
 * Uploads the project to its GitHub copy: a checkpoint of any changes first,
 * and never when a secret key would go with it (in the files, or in an old
 * checkpoint). Returns false when there was nothing new to upload.
 */
export function uploadToGitHub(projectId: string, projectPath: string, message = 'Checkpoint before backing up'): Promise<boolean> {
  return locked(projectPath, async () => {
    const dirty = await hasUncommittedChanges(projectPath)
    const branch = await currentBranch(projectPath)
    const upstream = await upstreamOf(projectPath, branch)
    // Nothing new (a question answered, a plan written): no scan, no network.
    if (!dirty && upstream && (await counts(projectPath, upstream)).ahead === 0) return false

    const leaks = await scanProject(projectPath, secretValues(projectId))
    if (leaks.length) {
      throw new Error(`Backup stopped: these files contain secret keys that would be uploaded:\n${describeLeaks(leaks)}\nMove them to Secrets first.`)
    }
    if (await isCliOnPath('gh')) {
      // Lets plain `git push` use the GitHub login.
      await run('gh', ['auth', 'setup-git', '--hostname', 'github.com'], projectPath).catch(() => undefined)
    }
    if (dirty) await checkpoint(projectPath, message)

    // Pushing uploads past checkpoints too, and a key that was committed once
    // and deleted later is still in them.
    const history = await git(projectPath, ['log', '-p', '--no-color', upstream ? `${upstream}..HEAD` : 'HEAD']).catch(() => '')
    const historyLeaks = scanDiff(history, secretValues(projectId))
    if (historyLeaks.length) {
      throw new Error(
        `Backup stopped: an earlier checkpoint contains a secret key, and uploading would publish it:\n${describeLeaks(historyLeaks)}\nAsk Claude to remove it from the project's git history, then back up again.`
      )
    }
    try {
      await git(projectPath, ['push', '-u', 'origin', 'HEAD'], 300_000)
    } catch (err) {
      if (/\[rejected\]|non-fast-forward|fetch first/i.test(String((err as { raw?: string }).raw ?? ''))) throw new BehindError()
      throw new Error(plainGitError(err))
    }
    note(projectId, { lastBackupAt: new Date().toISOString(), problem: undefined })
    return true
  })
}

/** Records why a backup didn't go (shown with the project's GitHub status). */
export function backupFailed(projectId: string, problem: string): void {
  note(projectId, { problem })
}

async function conflictedFiles(projectPath: string): Promise<string[]> {
  return (await git(projectPath, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean)
}

/**
 * Brings in the newer work from GitHub. Changes here are saved in a checkpoint
 * first. If both computers changed the same lines nothing here is changed and
 * the files are listed, so the user can choose.
 */
export function getLatest(projectId: string, projectPath: string): Promise<GitHubGetResult> {
  return locked(projectPath, async () => {
    await fetchOrigin(projectPath).catch((err) => {
      throw new Error(plainGitError(err))
    })
    const branch = await currentBranch(projectPath)
    const upstream = await upstreamOf(projectPath, branch)
    if (!upstream) return { status: 'up_to_date' }
    const before = await counts(projectPath, upstream)
    if (before.behind === 0) return { status: 'up_to_date' }
    if (await hasUncommittedChanges(projectPath)) {
      await checkpoint(projectPath, "This computer's work, saved before getting newer work from GitHub")
    }
    const { ahead } = await counts(projectPath, upstream)
    if (ahead === 0) {
      await git(projectPath, ['merge', '--ff-only', upstream])
      note(projectId, { problem: undefined })
      return { status: 'updated', count: before.behind, merged: false }
    }
    await ensureIdentity(projectPath)
    try {
      await git(projectPath, ['merge', '--no-edit', '-m', "Combine this computer's work with the newer work from GitHub", upstream])
    } catch (err) {
      const files = await conflictedFiles(projectPath)
      await git(projectPath, ['merge', '--abort']).catch(() => undefined)
      if (!files.length) throw new Error(plainGitError(err))
      return { status: 'conflict', files }
    }
    note(projectId, { problem: undefined })
    return { status: 'updated', count: before.behind, merged: true }
  })
}

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/**
 * Both computers changed the same lines and the user chose GitHub's version.
 * This computer's work is kept on its own branch (also uploaded, so it's safe
 * on GitHub too) before the project switches to GitHub's.
 */
export function useGitHubVersion(projectId: string, projectPath: string): Promise<{ keptAs: string }> {
  return locked(projectPath, async () => {
    await fetchOrigin(projectPath).catch((err) => {
      throw new Error(plainGitError(err))
    })
    const branch = await currentBranch(projectPath)
    const upstream = await upstreamOf(projectPath, branch)
    if (!upstream) throw new Error("GitHub doesn't have this project's branch yet.")
    if (await hasUncommittedChanges(projectPath)) {
      await checkpoint(projectPath, "This computer's work, kept before switching to GitHub's version")
    }
    const keptAs = `kept-from-this-computer-${stamp()}`
    await git(projectPath, ['branch', keptAs, 'HEAD'])
    await git(projectPath, ['push', 'origin', keptAs], 300_000).catch(() => undefined)
    await git(projectPath, ['reset', '--hard', upstream])
    note(projectId, { problem: undefined })
    return { keptAs }
  })
}

// ---- downloading a project --------------------------------------------------------------

async function ghLoggedIn(): Promise<boolean> {
  try {
    await run('gh', ['auth', 'status', '--hostname', 'github.com'], process.cwd())
    return true
  } catch {
    return false
  }
}

export async function githubAccount(): Promise<{ ghInstalled: boolean; loggedIn: boolean; login?: string }> {
  if (!(await isCliOnPath('gh'))) return { ghInstalled: false, loggedIn: false }
  if (!(await ghLoggedIn())) return { ghInstalled: true, loggedIn: false }
  const login = await run('gh', ['api', 'user', '--jq', '.login'], process.cwd(), 30_000).catch(() => '')
  return { ghInstalled: true, loggedIn: true, ...(login ? { login } : {}) }
}

/** The signed-in account's repositories (its own and its organisations'), most recently changed first. */
export async function listRepos(): Promise<GitHubRepoInfo[]> {
  const out = await run('gh', ['repo', 'list', '--limit', '300', '--json', 'nameWithOwner,description,isPrivate,updatedAt'], process.cwd(), 60_000).catch((err) => {
    throw new Error(plainGitError(err))
  })
  const list = JSON.parse(out || '[]') as { nameWithOwner: string; description: string | null; isPrivate: boolean; updatedAt: string }[]
  return list
    .map((r) => ({ nameWithOwner: r.nameWithOwner, description: r.description ?? '', private: r.isPrivate, updatedAt: r.updatedAt }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** "owner/name" from what the user typed or picked (a name, or a github.com address). */
export function parseRepo(input: string): string | null {
  const text = String(input ?? '').trim()
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(text)
  if (!m || m[2] === '.' || m[2] === '..') return null
  return `${m[1]}/${m[2]}`
}

/** Downloads a repository into a new folder inside `parent`. Returns the folder. */
export async function cloneRepo(repoInput: string, parent: string): Promise<string> {
  const repo = parseRepo(repoInput)
  if (!repo) throw new Error('Pick a repository, or type it as owner/name.')
  if (!parent || !existsSync(parent)) throw new Error("The folder to put it in doesn't exist.")
  const folder = join(parent, repo.split('/')[1])
  if (existsSync(folder)) {
    // Already downloaded here: just open it.
    if (existsSync(join(folder, '.git')) && (await githubUrl(folder))?.toLowerCase() === `https://github.com/${repo}`.toLowerCase()) return folder
    if (readdirSync(folder).length) throw new Error(`There's already a folder called "${repo.split('/')[1]}" there. Choose another place.`)
  }
  await run('gh', ['repo', 'clone', repo, folder], parent, 15 * 60_000).catch((err) => {
    throw new Error(plainGitError(err))
  })
  await run('gh', ['auth', 'setup-git', '--hostname', 'github.com'], folder).catch(() => undefined)
  return folder
}
