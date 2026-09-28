import type { CliStatus } from '@shared/types'
import { execCli, isCliOnPath, type ExecCliError } from './execCli'

interface ClaudeAuthStatus {
  loggedIn: boolean
  email?: string
  authMethod?: string
}

export async function checkClaudeStatus(): Promise<CliStatus> {
  if (!(await isCliOnPath('claude'))) {
    return { cli: 'claude', status: 'not_installed' }
  }

  // `claude auth status` exits 1 when logged out, but still prints valid JSON
  // on both stdout (exit 0) and the error's stdout (exit 1).
  let stdout: string
  try {
    ;({ stdout } = await execCli('claude', ['auth', 'status', '--json']))
  } catch (err) {
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
    return { cli: 'claude', status: 'logged_out', detail: 'Could not parse claude auth status' }
  }
}
