import type { CliStatus } from '@shared/types'
import { execCli, findCli, isInconclusive, type ExecCliError } from './execCli'

export async function checkCodexStatus(): Promise<CliStatus> {
  const found = await findCli('codex')
  if (found === 'missing') return { cli: 'codex', status: 'not_installed' }
  if (found === 'unknown') return { cli: 'codex', status: 'checking', inconclusive: true }

  // `codex login status` writes its message to stderr (not stdout) and exits
  // 1 when logged out, printing "Not logged in".
  let output: string
  try {
    const result = await execCli('codex', ['login', 'status'], { timeout: 30_000 })
    output = `${result.stdout}${result.stderr}`
  } catch (err) {
    if (isInconclusive(err)) return { cli: 'codex', status: 'checking', inconclusive: true }
    const cliErr = err as ExecCliError
    output = `${cliErr.stdout ?? ''}${cliErr.stderr ?? ''}`
  }

  if (/not logged in/i.test(output)) {
    return { cli: 'codex', status: 'logged_out', detail: output.trim() || undefined }
  }
  if (/logged in/i.test(output)) {
    return { cli: 'codex', status: 'logged_in', detail: output.trim() || undefined }
  }
  // Neither answer (empty or unexpected output): not proof of being logged out.
  return { cli: 'codex', status: 'checking', inconclusive: true, detail: output.trim() || undefined }
}
