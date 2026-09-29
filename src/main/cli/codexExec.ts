import { execFile, spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const CODEX_MEMORY_INSTRUCTIONS = `You have a persistent memory shared with Claude through the vibe_memory MCP tools. Call recall first to see what's known about this project. Before finishing, use remember to save anything worth keeping across sessions (architecture choices, how to run/build/test, gotchas), one standalone sentence per fact. Don't save secrets or temporary task state.`

export interface CodexLaunch {
  file: string
  prefixArgs: string[]
  env?: NodeJS.ProcessEnv
}

/**
 * Finds a way to start Codex without going through cmd.exe. On Windows an npm
 * install is a codex.cmd shim, and spawning that means cmd.exe parses the
 * whole command line: quotes and & in arguments can split it into extra
 * commands, and it caps the line at ~8K characters. The shim just runs
 * bin/codex.js with Node, and this app's own binary is a Node runtime
 * (ELECTRON_RUN_AS_NODE), so run codex.js directly.
 */
export async function resolveCodexLaunch(): Promise<CodexLaunch> {
  if (process.platform !== 'win32') return { file: 'codex', prefixArgs: [] }
  try {
    const { stdout } = await execFileAsync('where', ['codex'], { timeout: 5_000 })
    const matches = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const exe = matches.find((m) => m.toLowerCase().endsWith('.exe'))
    if (exe) return { file: exe, prefixArgs: [] }
    const shim = matches.find((m) => m.toLowerCase().endsWith('.cmd'))
    if (shim) {
      const codexJs = join(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      if (existsSync(codexJs)) {
        return {
          file: process.execPath,
          prefixArgs: [codexJs],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        }
      }
    }
  } catch {
    // fall through to the cmd.exe route
  }
  // Last resort. The prompt goes over stdin, so only app-controlled paths
  // pass through cmd.exe here.
  return { file: 'cmd.exe', prefixArgs: ['/d', '/s', '/c', 'codex'] }
}

export function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    // child.kill() only ends the direct child; Codex's own subprocesses
    // (and codex.exe under the node launcher) would keep running.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill()
  }
}

export interface CodexExecArgs {
  prompt: string
  cwd?: string
  timeoutMs?: number
  /** Go Nutz mode: no sandbox, no approval prompts. EXTREMELY DANGEROUS -- see codex exec --help. */
  unsandboxed?: boolean
  /** Codex model override; omitted means Codex's own configured default. */
  model?: string
  /** Paths to the shared memory MCP server's storage files and script, if memory access should be wired in. */
  memory?: {
    scriptPath: string
    projectMemoryPath: string
    globalMemoryPath: string
  }
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

  // --sandbox and --approve-for-me are mutually exclusive CLI flags
  // (confirmed: codex exec rejects the combination outright). MCP tool
  // calls require approval even under workspace-write, so when memory
  // access is wired in we need --approve-for-me instead of an explicit
  // --sandbox -- confirmed experimentally that --approve-for-me alone
  // still enforces an equivalent workspace-only write boundary (a write
  // outside the project folder was denied), regardless of this machine's
  // own ~/.codex/config.toml sandbox default, so it's a safe substitute.
  const prompt = args.memory ? `${CODEX_MEMORY_INSTRUCTIONS}\n\n${args.prompt}` : args.prompt

  const cliArgs = [
    'exec',
    '-', // read the prompt from stdin; see resolveCodexLaunch
    '--json',
    ...(args.unsandboxed
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : args.memory
        ? []
        : ['--sandbox', 'workspace-write']),
    '--skip-git-repo-check',
    '-o',
    outputPath
  ]
  if (args.cwd) {
    cliArgs.push('-C', args.cwd)
  }
  if (args.model) {
    cliArgs.push('-m', args.model)
  }
  if (args.memory && !args.unsandboxed) {
    cliArgs.push('--approve-for-me')
  }
  if (args.memory) {
    // TOML parsing of -c overrides needs forward slashes even on Windows --
    // a backslash-escaped Windows path in the value breaks the parser
    // (confirmed experimentally).
    const toForwardSlash = (p: string): string => p.replace(/\\/g, '/')
    cliArgs.push(
      '-c',
      `mcp_servers.vibe_memory.command="${toForwardSlash(process.execPath)}"`,
      '-c',
      `mcp_servers.vibe_memory.args=["${toForwardSlash(args.memory.scriptPath)}","${toForwardSlash(
        args.memory.projectMemoryPath
      )}","${toForwardSlash(args.memory.globalMemoryPath)}","codex"]`,
      '-c',
      'mcp_servers.vibe_memory.env={"ELECTRON_RUN_AS_NODE"="1"}'
    )
  }

  const launch = await resolveCodexLaunch()

  const events: CodexJsonEvent[] = []

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(launch.file, [...launch.prefixArgs, ...cliArgs], {
      windowsHide: true,
      env: launch.env
    })
    let stdoutBuffer = ''
    let stderrOutput = ''

    const timeout = args.timeoutMs
      ? setTimeout(() => {
          killTree(child)
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

    child.stdin.end(prompt)
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
