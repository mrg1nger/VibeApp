import { execFile } from 'child_process'
import { copyFileSync, existsSync, rmSync } from 'fs'
import { isAbsolute, join } from 'path'
import { randomUUID } from 'crypto'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// Dependency folders are huge, regenerable, and not something "undo" should
// ever touch -- even in a project whose .gitignore forgot them.
const EXCLUDES = ['node_modules', '.venv', 'venv', '__pycache__']
const EXCLUDE_PATHSPECS = EXCLUDES.flatMap((d) => [`:(exclude)${d}`, `:(exclude)**/${d}`])

// Snapshots are commits outside any branch, so they need no configured identity.
const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'VibeApp',
  GIT_AUTHOR_EMAIL: 'vibeapp@local',
  GIT_COMMITTER_NAME: 'VibeApp',
  GIT_COMMITTER_EMAIL: 'vibeapp@local'
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024
  })
  return stdout.trim()
}

/**
 * Records the project's current files (everything git would see, tracked or
 * not, minus ignored files) as a commit that isn't on any branch, so taking
 * one before every chat message doesn't clutter the checkpoint history. The
 * user's real index and working tree are never touched: the commit is built
 * from a throwaway index file. A ref under refs/vibeapp keeps it from being
 * garbage-collected.
 */
export async function takeSnapshot(projectPath: string, label: string): Promise<string> {
  let gitDir = await git(projectPath, ['rev-parse', '--git-dir'])
  if (!isAbsolute(gitDir)) gitDir = join(projectPath, gitDir)
  const tempIndex = join(gitDir, `vibeapp-index-${randomUUID()}`)
  // Starting from the real index lets git reuse its cached file stats
  // instead of re-hashing every file.
  const realIndex = join(gitDir, 'index')
  if (existsSync(realIndex)) copyFileSync(realIndex, tempIndex)
  const env = { GIT_INDEX_FILE: tempIndex, ...IDENTITY_ENV }
  try {
    await git(projectPath, ['add', '-A', '--', '.', ...EXCLUDE_PATHSPECS], env)
    const tree = await git(projectPath, ['write-tree'], env)
    const head = await git(projectPath, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')
    const commit = await git(
      projectPath,
      ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `VibeApp snapshot: ${label.slice(0, 200)}`],
      env
    )
    await git(projectPath, ['update-ref', `refs/vibeapp/snapshots/${commit}`, commit])
    return commit
  } finally {
    rmSync(tempIndex, { force: true })
  }
}

// Generated files that bloat a diff without saying anything about the change.
const NOISY_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', '*.min.js', '*.map']

/** Paths that differ between two snapshots (lockfiles and generated files left out). */
export async function changedFiles(projectPath: string, from: string, to: string): Promise<string[]> {
  const out = await git(projectPath, [
    'diff',
    '--name-only',
    from,
    to,
    '--',
    '.',
    ...NOISY_FILES.flatMap((f) => [`:(exclude)${f}`, `:(exclude)**/${f}`])
  ])
  return out ? out.split('\n').filter(Boolean) : []
}

/** The code change between two snapshots, as a unified diff (lockfiles left out). */
export async function diffSnapshots(projectPath: string, from: string, to: string): Promise<string> {
  return git(projectPath, [
    'diff',
    '--no-color',
    '--unified=3',
    from,
    to,
    '--',
    '.',
    ...NOISY_FILES.flatMap((f) => [`:(exclude)${f}`, `:(exclude)**/${f}`])
  ])
}

export interface RestoreResult {
  /** Snapshot of the files just before restoring, so the restore can be undone too. */
  redoSnapshot: string
  changedFiles: string[]
}

/**
 * Puts the project's files back exactly as they were in a snapshot: changed
 * files are restored, deleted ones come back, and files created since are
 * removed. Ignored files (and dependency folders) are left alone. Takes a
 * snapshot first, so every restore can itself be reversed.
 */
export async function restoreSnapshot(projectPath: string, snapshot: string): Promise<RestoreResult> {
  if (!/^[0-9a-f]{40,64}$/.test(snapshot)) throw new Error('Invalid snapshot id.')
  const redoSnapshot = await takeSnapshot(projectPath, 'before undo')
  const changed = await git(projectPath, ['diff', '--name-only', snapshot, redoSnapshot])
  const changedFiles = changed ? changed.split('\n') : []
  if (changedFiles.length === 0) return { redoSnapshot, changedFiles }

  // Make both the index and working tree match the snapshot (this also
  // deletes tracked files that aren't in it)...
  await git(projectPath, ['restore', `--source=${snapshot}`, '--staged', '--worktree', '--', ':/'])
  // ...then remove files created since, which are now untracked. Everything
  // that existed at snapshot time is in the index, so clean can't touch it.
  await git(projectPath, ['clean', '-fdq', ...EXCLUDES.flatMap((d) => ['-e', d]), '--', ':/'])
  // Leave the index matching the last real commit again, as the user had it.
  await git(projectPath, ['reset', '-q']).catch(() => undefined)
  return { redoSnapshot, changedFiles }
}
