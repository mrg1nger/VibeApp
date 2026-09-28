import { randomUUID } from 'crypto'
import type { CliName } from '@shared/types'
import { PtySession } from './ptySession'

const installCommand: Record<CliName, { file: string; args: string[] }> = {
  claude: { file: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
  codex: { file: 'npm', args: ['install', '-g', '@openai/codex'] }
}

const WINGET_ARGS = ['--source', 'winget', '--accept-package-agreements', '--accept-source-agreements']

const sessions = new Map<string, PtySession>()

function startWingetInstall(packageId: string): PtySession {
  const id = randomUUID()
  const session = new PtySession(id, {
    file: 'winget',
    args: ['install', '--id', packageId, ...WINGET_ARGS]
  })
  sessions.set(id, session)
  session.once('exit', () => sessions.delete(id))
  return session
}

export function startInstallSession(cli: CliName): PtySession {
  const id = randomUUID()
  const { file, args } = installCommand[cli]
  const session = new PtySession(id, { file, args })
  sessions.set(id, session)
  session.once('exit', () => sessions.delete(id))
  return session
}

export function startNodeInstallSession(): PtySession {
  return startWingetInstall('OpenJS.NodeJS.LTS')
}

export function startGitInstallSession(): PtySession {
  return startWingetInstall('Git.Git')
}

export function getInstallSession(id: string): PtySession | undefined {
  return sessions.get(id)
}

export function disposeInstallSession(id: string): void {
  sessions.get(id)?.dispose()
  sessions.delete(id)
}
