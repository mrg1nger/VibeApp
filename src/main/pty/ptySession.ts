import { EventEmitter } from 'events'
import * as pty from 'node-pty'

export interface PtySessionOptions {
  file: string
  args: string[]
  cwd?: string
  cols?: number
  rows?: number
  env?: NodeJS.ProcessEnv
}

export class PtySession extends EventEmitter {
  private ptyProcess: pty.IPty
  public readonly id: string

  constructor(id: string, options: PtySessionOptions) {
    super()
    this.id = id

    // On Windows, node-pty's ConPTY-based spawn calls CreateProcess directly
    // and does not apply PATHEXT resolution -- a bare command name (e.g.
    // "codex") fails to launch if it only exists as a "codex.cmd" npm shim,
    // even though it resolves fine in a real terminal. Routing through
    // cmd.exe /c gives the same PATHEXT/shim resolution a real terminal has.
    const [file, args] =
      process.platform === 'win32'
        ? ['cmd.exe', ['/c', options.file, ...options.args]]
        : [options.file, options.args]

    this.ptyProcess = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 30,
      cwd: options.cwd,
      env: (options.env as { [key: string]: string }) ?? (process.env as { [key: string]: string })
    })

    this.ptyProcess.onData((data) => this.emit('data', data))
    this.ptyProcess.onExit(({ exitCode, signal }) => this.emit('exit', exitCode, signal))
  }

  write(data: string): void {
    this.ptyProcess.write(data)
  }

  resize(cols: number, rows: number): void {
    this.ptyProcess.resize(cols, rows)
  }

  dispose(): void {
    this.ptyProcess.kill()
  }
}
