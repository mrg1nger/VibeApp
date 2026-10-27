import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { simpleGit } from 'simple-git'
import type { CheckpointRecord } from '@shared/types'
import { isCliOnPath } from '../cli/execCli'

const DEFAULT_GITIGNORE = `node_modules
dist
out
build
.env
.env.*
*.log
`

/**
 * Ensures `git commit` won't fail for lack of a configured identity. Checks
 * unscoped first (so an existing global/system identity, the common case on
 * a real dev machine, is left alone) and only writes a repo-local override
 * when nothing resolves at all -- confirmed experimentally that
 * getConfig(key, 'local') alone reports null on a fresh repo even when a
 * global identity exists and a commit would succeed fine, so checking with
 * a scope would falsely think an override is needed.
 */
async function ensureGitIdentity(git: ReturnType<typeof simpleGit>): Promise<void> {
  const name = await git.getConfig('user.name')
  const email = await git.getConfig('user.email')
  if (!name.value) {
    await git.addConfig('user.name', 'VibeApp User', false, 'local')
  }
  if (!email.value) {
    await git.addConfig('user.email', 'vibeapp@local', false, 'local')
  }
}

export async function ensureRepo(projectPath: string): Promise<void> {
  const gitDir = join(projectPath, '.git')
  if (existsSync(gitDir)) return

  // simple-git's own error when the git binary is missing isn't consistently
  // clear (varies by platform/version), so check explicitly first rather
  // than surfacing whatever it happens to throw.
  if (!(await isCliOnPath('git'))) {
    throw new Error(
      'git is not installed (or not on PATH). Install it from git-scm.com, then try again.'
    )
  }

  const git = simpleGit(projectPath)
  await git.init()
  await ensureGitIdentity(git)

  const gitignorePath = join(projectPath, '.gitignore')
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, DEFAULT_GITIGNORE, 'utf-8')
  }

  await git.add('.gitignore')
  const status = await git.status()
  if (status.staged.length > 0) {
    await git.commit('Initial checkpoint')
  }
}

/** Makes sure a commit (or a merge) won't fail for lack of a name and email. */
export async function ensureIdentity(projectPath: string): Promise<void> {
  await ensureGitIdentity(simpleGit(projectPath))
}

export async function hasUncommittedChanges(projectPath: string): Promise<boolean> {
  const git = simpleGit(projectPath)
  const status = await git.status()
  return !status.isClean()
}

export async function suggestCheckpointMessage(projectPath: string): Promise<string> {
  const git = simpleGit(projectPath)
  const status = await git.status()
  const changedPaths = [
    ...status.created,
    ...status.modified,
    ...status.not_added,
    ...status.deleted,
    ...status.renamed.map((r) => r.to)
  ]

  if (changedPaths.length === 0) return 'Checkpoint'
  if (changedPaths.length === 1) return `Update ${changedPaths[0]}`
  if (changedPaths.length <= 3) return `Update ${changedPaths.join(', ')}`
  return `Update ${changedPaths.length} files`
}

export async function checkpoint(projectPath: string, message: string): Promise<CheckpointRecord> {
  const git = simpleGit(projectPath)
  await ensureGitIdentity(git)
  await git.add('-A')
  const commitResult = await git.commit(message)
  const log = await git.log({ maxCount: 1 })
  const latest = log.latest

  return {
    hash: commitResult.commit || latest?.hash || '',
    message,
    date: latest?.date ?? new Date().toISOString()
  }
}

export async function history(projectPath: string): Promise<CheckpointRecord[]> {
  const git = simpleGit(projectPath)
  const isRepo = await git.checkIsRepo()
  if (!isRepo) return []

  const log = await git.log({ maxCount: 100 })
  return log.all.map((entry) => ({
    hash: entry.hash,
    message: entry.message,
    date: entry.date
  }))
}

/**
 * Restores the working tree to a past checkpoint by creating a new branch at
 * that commit and checking it out, rather than resetting the current branch
 * in place -- so the commits made after that checkpoint are never discarded,
 * only left behind on the original branch.
 */
export async function restoreCheckpoint(projectPath: string, commitHash: string): Promise<string> {
  const git = simpleGit(projectPath)
  const branchName = `checkpoint-${commitHash.slice(0, 8)}-${Date.now()}`
  await git.checkout(['-b', branchName, commitHash])
  return branchName
}
