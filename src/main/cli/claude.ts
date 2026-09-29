import type { CliStatus } from '@shared/types'
import { execCli, findCli, isInconclusive, type ExecCliError } from './execCli'

interface ClaudeAuthStatus {
  loggedIn: boolean
  email?: string
  authMethod?: string
}

export async function checkClaudeStatus(): Promise<CliStatus> {
  const found = await findCli('claude')
  if (found === 'missing') return { cli: 'claude', status: 'not_installed' }
  if (found === 'unknown') return { cli: 'claude', status: 'checking', inconclusive: true }

  // `claude auth status` exits 1 when logged out, but still prints valid JSON
  // on both stdout (exit 0) and the error's stdout (exit 1).
  let stdout: string
  try {
    ;({ stdout } = await execCli('claude', ['auth', 'status', '--json'], { timeout: 30_000 }))
  } catch (err) {
    if (isInconclusive(err)) return { cli: 'claude', status: 'checking', inconclusive: true }
    stdout = (err as ExecCliError).stdout ?? ''
  }

  try {
    const parsed = JSON.parse(stdout) as ClaudeAuthStatus
    return {
      cli: 'claude',
      status: parsed.loggedIn ? 'logged_in' : 'logged_out',
      detail: parsed.email
    }
  } catch {
    // No usable answer (cut off, or some other output): don't call that logged out.
    return { cli: 'claude', status: 'checking', inconclusive: true, detail: 'Could not parse claude auth status' }
  }
}
