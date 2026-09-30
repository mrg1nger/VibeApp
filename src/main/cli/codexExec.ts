import { execFile, spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const CODEX_MEMORY_INSTRUCTIONS = `You have a persistent memory shared with Claude through the vibe_memory MCP tools. The project's key facts are below; for anything else, search with recall (a short query like "sprites" or "tests"). Before finishing, use remember to save anything worth keeping across sessions (how to run/build/test, decisions, gotchas), one standalone sentence per fact with a category. If a remembered fact is wrong or outdated, fix it with update or forget instead of saving a contradicting one. Don't save secrets or temporary task state.`

export interface CodexLaunch {
  file: string
  prefixArgs: string[]
  env?: NodeJS.ProcessEnv
}

const WINDOWS_TARGET = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
const WINDOWS_PACKAGE = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64'

/**
 * The native codex.exe inside an npm install, found the same way the
 * package's own bin/codex.js launcher finds it.
 */
function nativeCodexExe(packageRoot: string): string | undefined {
  const vendorRoots = [
    join(packageRoot, 'node_modules', '@openai', WINDOWS_PACKAGE, 'vendor'),
    join(packageRoot, '..', WINDOWS_PACKAGE, 'vendor'), // hoisted
    join(packageRoot, 'vendor')
  ]
  return vendorRoots.map((root) => join(root, WINDOWS_TARGET, 'bin', 'codex.exe')).find((p) => existsSync(p))
}

let cachedLaunch: CodexLaunch | undefined

/**
 * Finds a way to start Codex without going through cmd.exe. On Windows an npm
 * install is a codex.cmd shim, and spawning that means cmd.exe parses the
 * whole command line: quotes and & in arguments can split it into extra
 * commands, and it caps the line at ~8K characters.
 *
 * Best is the native codex.exe itself. The shim's bin/codex.js launcher
 * starts it without hiding its window, so from a windowless app every run
 * flashed a console window on screen. codex.js via this app's own Node
 * runtime (ELECTRON_RUN_AS_NODE) is the fallback.
 */
export async function resolveCodexLaunch(): Promise<CodexLaunch> {
  if (process.platform !== 'win32') return { file: 'codex', prefixArgs: [] }
  if (cachedLaunch && existsSync(cachedLaunch.prefixArgs[0] ?? cachedLaunch.file)) return cachedLaunch
  try {
    const { stdout } = await execFileAsync('where', ['codex'], { timeout: 5_000, windowsHide: true })
    const matches = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const exe = matches.find((m) => m.toLowerCase().endsWith('.exe'))
    if (exe) return (cachedLaunch = { file: exe, prefixArgs: [] })
    const shim = matches.find((m) => m.toLowerCase().endsWith('.cmd'))
    if (shim) {
      const packageRoot = join(dirname(shim), 'node_modules', '@openai', 'codex')
      const native = nativeCodexExe(packageRoot)
      if (native) {
        return (cachedLaunch = {
          file: native,
          prefixArgs: [],
          // What codex.js sets: lets Codex give the right update instructions.
          env: { ...process.env, CODEX_MANAGED_PACKAGE_ROOT: packageRoot, CODEX_MANAGED_BY_NPM: '1' }
        })
      }
      const codexJs = join(packageRoot, 'bin', 'codex.js')
      if (existsSync(codexJs)) {
        return (cachedLaunch = {
          file: process.execPath,
          prefixArgs: [codexJs],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        })
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
  /** Look but don't touch: read-only sandbox (overrides the other sandbox options). */
  readOnly?: boolean
  /** Don't keep a Codex session file for this run. */
  ephemeral?: boolean
  /** JSON Schema the final message must follow (it's then a JSON string). */
  outputSchema?: object
  /** Aborting kills the Codex process and rejects. */
  signal?: AbortSignal
  /** The shared memory MCP server's script and database, if memory access should be wired in. */
  memory?: {
    scriptPath: string
    dbPath: string
    /** App-generated id (safe to embed in a TOML string). */
    projectId: string
    /** The project's key facts, given to Codex up front. */
    keyFacts?: string
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
  const prompt = args.memory
    ? `${CODEX_MEMORY_INSTRUCTIONS}\n\nKey facts:\n${args.memory.keyFacts ?? '(none yet)'}\n\n${args.prompt}`
    : args.prompt

  const cliArgs = [
    'exec',
    '-', // read the prompt from stdin; see resolveCodexLaunch
    '--json',
    ...(args.readOnly
      ? ['--sandbox', 'read-only']
      : args.unsandboxed
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
  if (args.ephemeral) {
    cliArgs.push('--ephemeral')
  }
  if (args.outputSchema) {
    const schemaPath = join(tempDir, 'schema.json')
    writeFileSync(schemaPath, JSON.stringify(args.outputSchema), 'utf-8')
    cliArgs.push('--output-schema', schemaPath)
  }
  if (args.memory && !args.unsandboxed && !args.readOnly) {
    cliArgs.push('--approve-for-me')
  }
  if (args.memory && !args.readOnly) {
    // TOML parsing of -c overrides needs forward slashes even on Windows --
    // a backslash-escaped Windows path in the value breaks the parser
    // (confirmed experimentally).
    const toForwardSlash = (p: string): string => p.replace(/\\/g, '/')
    cliArgs.push(
      '-c',
      `mcp_servers.vibe_memory.command="${toForwardSlash(process.execPath)}"`,
      '-c',
      `mcp_servers.vibe_memory.args=["${toForwardSlash(args.memory.scriptPath)}","${toForwardSlash(
        args.memory.dbPath
      )}","${args.memory.projectId}","codex"]`,
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

    const onAbort = (): void => {
      if (timeout) clearTimeout(timeout)
      killTree(child)
      reject(new Error('Codex run was cancelled'))
    }
    if (args.signal?.aborted) onAbort()
    args.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('exit', () => args.signal?.removeEventListener('abort', onAbort))

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
