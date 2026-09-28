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
