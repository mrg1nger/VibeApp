import { randomUUID } from 'crypto'
import type { CliName } from '@shared/types'
import { PtySession } from './ptySession'

const loginCommand: Record<CliName, { file: string; args: string[] }> = {
  claude: { file: 'claude', args: ['auth', 'login'] },
  codex: { file: 'codex', args: ['login'] }
}

const sessions = new Map<string, PtySession>()

export function startLoginSession(cli: CliName): PtySession {
  const id = randomUUID()
  const { file, args } = loginCommand[cli]
  const session = new PtySession(id, { file, args })
  sessions.set(id, session)
  session.once('exit', () => sessions.delete(id))
  return session
}

export function getLoginSession(id: string): PtySession | undefined {
  return sessions.get(id)
}

export function disposeLoginSession(id: string): void {
  sessions.get(id)?.dispose()
  sessions.delete(id)
}
