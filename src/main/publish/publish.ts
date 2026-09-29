import { execFile } from 'child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { promisify } from 'util'
import type { PublishStatus } from '@shared/types'
import { isCliOnPath } from '../cli/execCli'
import { checkpoint, hasUncommittedChanges } from '../git/repo'
import { getProject } from '../projects/store'
import { describeLeaks, scanDiff, scanProject } from '../secrets/leakScan'
import { listSecrets, secretEnv, secretValues } from '../secrets/vault'
import type { PtySessionOptions } from '../pty/ptySession'

const execFileAsync = promisify(execFile)

async function run(file: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    cwd,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024
  })
  return stdout.trim()
}

async function githubRemote(projectPath: string): Promise<string | null> {
  try {
    const url = await run('git', ['remote', 'get-url', 'origin'], projectPath)
    return url.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/') || null
  } catch {
    return null
  }
}

async function ghLoggedIn(): Promise<boolean> {
  try {
    await run('gh', ['auth', 'status', '--hostname', 'github.com'], process.cwd())
    return true
  } catch {
    return false
  }
}

async function vercelLoggedIn(): Promise<boolean> {
  try {
    const npx = await resolveNpx()
    await execFileAsync(npx.file, [...npx.prefixArgs, '--yes', 'vercel@latest', 'whoami'], {
      windowsHide: true,
      timeout: 90_000
    })
    return true
  } catch {
    return false
  }
}

export async function publishStatus(projectId: string, projectPath: string): Promise<PublishStatus> {
  const [ghInstalled, nodeInstalled] = await Promise.all([isCliOnPath('gh'), isCliOnPath('node')])
  const [ghAuthed, vercelAuthed, githubUrl, leaks] = await Promise.all([
    ghInstalled ? ghLoggedIn() : Promise.resolve(false),
    nodeInstalled ? vercelLoggedIn() : Promise.resolve(false),
    githubRemote(projectPath),
    scanProject(projectPath, secretValues(projectId))
  ])
  let secretNames: string[] = []
  try {
    secretNames = listSecrets(projectId).map((s) => s.name)
  } catch {
    // Unreadable vault: publish without offering secrets.
  }
  return {
    ghInstalled,
    ghLoggedIn: ghAuthed,
    vercelLoggedIn: vercelAuthed,
    githubUrl,
    deployUrl: getProject(projectId)?.deployUrl ?? null,
    secretNames,
    leaks,
    nodeInstalled
  }
}

async function assertNoLeaks(projectId: string, projectPath: string): Promise<void> {
  const leaks = await scanProject(projectPath, secretValues(projectId))
  if (leaks.length) {
    throw new Error(
      `Publishing stopped: these files contain secret keys that would be uploaded:\n${describeLeaks(leaks)}\nMove them to Secrets first.`
    )
  }
}

export function ghLoginSessionOptions(): PtySessionOptions {
  return {
    file: 'gh',
    args: ['auth', 'login', '--web', '--git-protocol', 'https', '--hostname', 'github.com', '--skip-ssh-key']
  }
}

/** Pushes the project to GitHub, creating the repository the first time. Returns its URL. */
export async function publishToGitHub(
  projectId: string,
  projectPath: string,
  options: { name: string; visibility: 'private' | 'public' }
): Promise<string> {
  await assertNoLeaks(projectId, projectPath)
  // Lets plain `git push` use the GitHub login.
  await run('gh', ['auth', 'setup-git', '--hostname', 'github.com'], projectPath)
  if (await hasUncommittedChanges(projectPath)) {
    await checkpoint(projectPath, 'Checkpoint before publishing')
  }

  // Pushing uploads past checkpoints too, and a key that was committed once
  // and deleted later is still in them.
  const existing = await githubRemote(projectPath)
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)
  const alreadyPushed = existing
    ? await run('git', ['rev-parse', '--verify', '-q', `origin/${branch}`], projectPath).catch(() => '')
    : ''
  const history = await run(
    'git',
    ['log', '-p', '--no-color', alreadyPushed ? `${alreadyPushed}..HEAD` : 'HEAD'],
    projectPath
  ).catch(() => '')
  const historyLeaks = scanDiff(history, secretValues(projectId))
  if (historyLeaks.length) {
    throw new Error(
      `Publishing stopped: an earlier checkpoint contains a secret key, and pushing would publish it:\n${describeLeaks(historyLeaks)}\nAsk Claude to remove it from the project's git history, then publish again.`
    )
  }

  if (existing) {
    await run('git', ['push', '-u', 'origin', 'HEAD'], projectPath)
    return existing
  }
  const name = options.name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!name) throw new Error('Pick a name for the repository.')
  await run(
    'gh',
    ['repo', 'create', name, `--${options.visibility}`, '--source', '.', '--remote', 'origin', '--push'],
    projectPath
  )
  return (await githubRemote(projectPath)) ?? `https://github.com/${name}`
}

const REQUIRED_VERCEL_IGNORES = ['.env', '.env.*', '.vercel', '.git', 'node_modules']

/**
 * The Vercel CLI doesn't go by .gitignore, and doesn't skip .env files on
 * its own, so make sure a .vercelignore keeps them (and everything git
 * ignores) out of the upload.
 */
function ensureVercelIgnore(projectPath: string): void {
  // Vercel's link folder (created on first deploy) shouldn't be committed.
  const gitignorePath = join(projectPath, '.gitignore')
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : ''
  if (!/^\.vercel\/?$/m.test(gitignore)) appendFileSync(gitignorePath, `\n.vercel\n`, 'utf-8')

  const ignorePath = join(projectPath, '.vercelignore')
  if (!existsSync(ignorePath)) {
    writeFileSync(
      ignorePath,
      `# Files VibeApp keeps out of Vercel deployments (copied from .gitignore, plus secrets).\n${readFileSync(gitignorePath, 'utf-8').trim()}\n${REQUIRED_VERCEL_IGNORES.join('\n')}\n`,
      'utf-8'
    )
    return
  }
  const lines = new Set(readFileSync(ignorePath, 'utf-8').split(/\r?\n/).map((l) => l.trim()))
  const missing = REQUIRED_VERCEL_IGNORES.filter((l) => !lines.has(l))
  if (missing.length) appendFileSync(ignorePath, `\n${missing.join('\n')}\n`, 'utf-8')
}

/**
 * npx, started through Node itself rather than the npx.cmd shim, so no
 * argument (secret values included) is ever parsed by cmd.exe.
 */
async function resolveNpx(): Promise<{ file: string; prefixArgs: string[] }> {
  if (process.platform !== 'win32') return { file: 'npx', prefixArgs: [] }
  const { stdout } = await execFileAsync('where', ['node'], { windowsHide: true })
  const nodeExe = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith('node.exe'))
  if (nodeExe) {
    const npxCli = join(dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npx-cli.js')
    if (existsSync(npxCli)) return { file: nodeExe, prefixArgs: [npxCli] }
  }
  throw new Error("Couldn't find npx next to Node.js. Try reinstalling Node from the Accounts tab.")
}

/**
 * Vercel sign-in. It has to be its own step: with --yes, `vercel deploy`
 * won't start a login and just fails with "No existing credentials found".
 */
export async function vercelLoginSessionOptions(): Promise<PtySessionOptions> {
  const npx = await resolveNpx()
  return { file: npx.file, args: [...npx.prefixArgs, '--yes', 'vercel@latest', 'login'], direct: true }
}

/** Vercel's device sign-in page, as printed by `vercel login`. */
export function parseVercelLoginUrl(output: string): string | null {
  return /https:\/\/vercel\.com\/oauth\/device\?user_code=[A-Z0-9-]+/.exec(output)?.[0] ?? null
}

/** The terminal command that deploys the project to Vercel (already signed in). */
export async function vercelDeploySessionOptions(
  projectId: string,
  projectPath: string,
  includeSecrets: boolean
): Promise<PtySessionOptions> {
  await assertNoLeaks(projectId, projectPath)
  ensureVercelIgnore(projectPath)
  const npx = await resolveNpx()
  const secretArgs = includeSecrets
    ? Object.entries(secretEnv(projectId)).flatMap(([name, value]) => [
        '--env',
        `${name}=${value}`,
        '--build-env',
        `${name}=${value}`
      ])
    : []
  return {
    file: npx.file,
    args: [...npx.prefixArgs, '--yes', 'vercel@latest', 'deploy', '--prod', '--yes', ...secretArgs],
    cwd: projectPath,
    direct: true
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

/** The public URL from a Vercel deploy's output: the stable alias if shown, else the deployment URL. */
export function parseVercelUrl(output: string): string | null {
  const lines = output.replace(ANSI, '').split(/\r?\n/)
  const urlIn = (line: string): string | undefined => /https:\/\/[a-z0-9.-]+\.vercel\.app/i.exec(line)?.[0]
  for (const marker of [/aliased/i, /production/i]) {
    const line = [...lines].reverse().find((l) => marker.test(l) && urlIn(l))
    if (line) return urlIn(line)!
  }
  const all = lines.map(urlIn).filter(Boolean) as string[]
  return all.at(-1) ?? null
}
