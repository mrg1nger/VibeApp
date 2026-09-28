import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface ExecCliResult {
  stdout: string
  stderr: string
}

export interface ExecCliError extends Error {
  code?: number
  stdout: string
  stderr: string
}

/**
 * On Windows, globally-installed npm CLIs resolve to a .cmd shim, which
 * execFile cannot launch directly (CreateProcess needs the literal
 * extension, and it does not apply PATHEXT resolution the way a real shell
 * does). Routing through cmd.exe /c gives the same resolution a real
 * terminal has, and passing args as an execFile array (never a shell
 * string) keeps this safe even if a future caller's args become dynamic --
 * there is no string concatenation for a shell to reinterpret.
 */
function toPlatformInvocation(command: string, args: string[]): { file: string; args: string[] } {
  return process.platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] }
    : { file: command, args }
}

/**
 * True if `command` resolves to something on PATH. Uses `where`/`command -v`
 * rather than trying to spawn the CLI itself, so a real invocation never has
 * to distinguish "not installed" from "installed but exited non-zero."
 */
export async function isCliOnPath(command: string): Promise<boolean> {
  const { file, args } = toPlatformInvocation(
    process.platform === 'win32' ? 'where' : 'command',
    process.platform === 'win32' ? [command] : ['-v', command]
  )
  try {
    await execFileAsync(file, args, { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

/** Runs a CLI binary by name (see toPlatformInvocation for the Windows shim caveat). */
export async function execCli(
  command: string,
  args: string[],
  options: { timeout?: number } = {}
): Promise<ExecCliResult> {
  const { file, args: finalArgs } = toPlatformInvocation(command, args)
  try {
    return await execFileAsync(file, finalArgs, { timeout: options.timeout ?? 10_000 })
  } catch (err) {
    throw err as ExecCliError
  }
}
