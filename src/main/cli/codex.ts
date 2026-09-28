import type { CliStatus } from '@shared/types'
import { execCli, isCliOnPath, type ExecCliError } from './execCli'

export async function checkCodexStatus(): Promise<CliStatus> {
  if (!(await isCliOnPath('codex'))) {
    return { cli: 'codex', status: 'not_installed' }
  }

  // `codex login status` writes its message to stderr (not stdout) and exits
  // 1 when logged out, printing "Not logged in".
  let output: string
  try {
    const result = await execCli('codex', ['login', 'status'])
    output = `${result.stdout}${result.stderr}`
  } catch (err) {
    const cliErr = err as ExecCliError
    output = `${cliErr.stdout ?? ''}${cliErr.stderr ?? ''}`
  }

  const loggedIn = !/not logged in/i.test(output) && /logged in/i.test(output)
  return {
    cli: 'codex',
    status: loggedIn ? 'logged_in' : 'logged_out',
    detail: output.trim() || undefined
  }
}
