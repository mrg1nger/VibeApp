import { spawn } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

export interface CodexExecArgs {
  prompt: string
  cwd?: string
  timeoutMs?: number
  /** Go Nutz mode: no sandbox, no approval prompts. EXTREMELY DANGEROUS -- see codex exec --help. */
  unsandboxed?: boolean
}

export interface CodexExecResult {
  finalMessage: string
  exitCode: number
  events: CodexJsonEvent[]
}

export interface CodexJsonEvent {
  type: string
  [key: string]: unknown
}

export type CodexProgressListener = (note: string) => void

/**
 * Runs `codex exec` non-interactively for one delegated subtask and returns
 * its final message. Uses --output-last-message to a temp file for a clean
 * final string, since the JSONL stream's last "agent_message" item is not
 * reliably the true final output (other item types can follow it).
 */
export async function runCodexExec(
  args: CodexExecArgs,
  onProgress?: CodexProgressListener
): Promise<CodexExecResult> {
  const tempDir = mkdtempSync(join(tmpdir(), 'vibeapp-codex-'))
  const outputPath = join(tempDir, `${randomUUID()}.txt`)

  const cliArgs = [
    'exec',
    args.prompt,
    '--json',
    ...(args.unsandboxed
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'workspace-write']),
    '--skip-git-repo-check',
    '-o',
    outputPath
  ]
  if (args.cwd) {
    cliArgs.push('-C', args.cwd)
  }

  // Windows: `codex` resolves to an npm .cmd shim, which spawn() cannot
  // launch directly (CreateProcess skips PATHEXT resolution) -- route
  // through cmd.exe /c the same way ptySession.ts and execCli.ts do.
  const [file, finalArgs] =
    process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', 'codex', ...cliArgs]] : ['codex', cliArgs]

  const events: CodexJsonEvent[] = []

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(file, finalArgs, { windowsHide: true })
    let stdoutBuffer = ''
    let stderrOutput = ''

    const timeout = args.timeoutMs
      ? setTimeout(() => {
          child.kill()
          reject(new Error(`Codex subtask timed out after ${args.timeoutMs}ms`))
        }, args.timeoutMs)
      : undefined

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as CodexJsonEvent
          events.push(event)
          const note = describeCodexEvent(event)
          if (note) onProgress?.(note)
        } catch {
          // Non-JSON line (e.g. "Reading additional input from stdin..."); ignore.
        }
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString('utf-8')
    })

    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout)
      reject(err)
    })

    child.on('exit', (code) => {
      if (timeout) clearTimeout(timeout)
      if (code === null) {
        reject(new Error(`Codex process exited without a code. stderr: ${stderrOutput.slice(0, 500)}`))
        return
      }
      resolve(code)
    })

    // Codex reads from stdin if no prompt arg is given; since we always pass
    // one as an argument, close stdin immediately so it never waits on it.
    child.stdin.end()
  })

  let finalMessage = ''
  try {
    finalMessage = readFileSync(outputPath, 'utf-8').trim()
  } catch {
    // No output file written (e.g. the process crashed before finishing).
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }

  if (!finalMessage) {
    const lastAgentMessage = [...events]
      .reverse()
      .find((e) => e.type === 'item.completed' && isAgentMessageItem(e))
    finalMessage = isAgentMessageItem(lastAgentMessage) ? lastAgentMessage.item.text : ''
  }

  return { finalMessage, exitCode, events }
}

interface AgentMessageEvent extends CodexJsonEvent {
  item: { type: 'agent_message'; text: string }
}

function isAgentMessageItem(event: CodexJsonEvent | undefined): event is AgentMessageEvent {
  return (
    !!event &&
    typeof event.item === 'object' &&
    event.item !== null &&
    (event.item as { type?: string }).type === 'agent_message'
  )
}

function describeCodexEvent(event: CodexJsonEvent): string | null {
  const item = event.item as { type?: string; command?: string; changes?: Array<{ path: string }> } | undefined
  if (event.type === 'item.started' && item?.type === 'command_execution') {
    return `Running: ${item.command}`
  }
  if (event.type === 'item.started' && item?.type === 'file_change') {
    const paths = item.changes?.map((c) => c.path.split(/[\\/]/).pop()).join(', ')
    return `Editing: ${paths}`
  }
  if (event.type === 'item.completed' && item?.type === 'agent_message') {
    return null // final text is surfaced via the tool result, not as progress
  }
  return null
}
