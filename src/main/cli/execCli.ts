import { execFile } from 'child_process'
import { join } from 'path'
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
  return (await findCli(command)) === 'found'
}

/**
 * Like isCliOnPath, but tells "not installed" apart from "couldn't tell":
 * on a busy machine the lookup can time out, which says nothing about
 * whether the tool is installed.
 */
export async function findCli(command: string): Promise<'found' | 'missing' | 'unknown'> {
  const { file, args } = toPlatformInvocation(
    process.platform === 'win32' ? 'where' : 'command',
    process.platform === 'win32' ? [command] : ['-v', command]
  )
  try {
    await execFileAsync(file, args, { timeout: 15_000, windowsHide: true })
    return 'found'
  } catch (err) {
    return isInconclusive(err) ? 'unknown' : 'missing'
  }
}

/** A run that was killed (timeout) or never started, rather than one that answered. */
export function isInconclusive(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string | null; code?: unknown }
  return !!e.killed || !!e.signal || typeof e.code === 'string'
}

/**
 * Installers (winget Node/Git, npm -g) update PATH in the registry, but a
 * running process keeps the PATH it started with, so newly installed tools
 * look missing until the app restarts. Re-read the machine and user PATH and
 * merge them into this process's environment (children inherit it).
 */
export async function refreshPathFromRegistry(): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    // Absolute path: this is repairing PATH, so it can't rely on PATH.
    const powershell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    const { stdout } = await execFileAsync(
      powershell,
      [
        '-NoProfile',
        '-Command',
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"
      ],
      { timeout: 10_000, windowsHide: true }
    )
    const current = (process.env.PATH ?? '').split(';')
    const merged = [...current]
    for (const entry of stdout.trim().split(';')) {
      if (entry && !merged.some((e) => e.toLowerCase() === entry.toLowerCase())) merged.push(entry)
    }
    process.env.PATH = merged.filter(Boolean).join(';')
  } catch {
    // Keep the existing PATH; a restart still picks up the change.
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
    return await execFileAsync(file, finalArgs, { timeout: options.timeout ?? 10_000, windowsHide: true })
  } catch (err) {
    throw err as ExecCliError
  }
}
