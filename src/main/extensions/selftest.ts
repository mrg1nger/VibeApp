import { spawn } from 'child_process'
import { killTree } from '../cli/codexExec'

export type SelfTestResult = { ok: true; tools: string[] } | { ok: false; error: string }

/** A tool call that proves the server really works, not just that it starts. */
export interface SelfTestProbe {
  tool: string
  arguments: Record<string, unknown>
  /** What the check is doing, for the error message. */
  doing: string
}

const TIMEOUT_MS = 90_000 // the first npx run may have to download the package (and a browser check is slower)

/**
 * Starts an MCP server the way the agents will, asks it for its tool list,
 * optionally calls one tool, and stops it again. Catches a server that won't
 * start, crashes at once, doesn't speak MCP, or fails at its actual job,
 * before anything depends on it.
 */
export function selfTestServer(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
  probe?: SelfTestProbe
): Promise<SelfTestResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let buffer = ''
    let stderr = ''
    let finished = false
    let tools: string[] = []
    const finish = (result: SelfTestResult): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      killTree(child)
      resolve(result)
    }
    const send = (message: object): void => {
      child.stdin.write(JSON.stringify(message) + '\n')
    }
    const timer = setTimeout(
      () => finish({ ok: false, error: `It didn't answer within ${TIMEOUT_MS / 1000} seconds.${tail(stderr)}` }),
      TIMEOUT_MS
    )

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        let message: {
          id?: number
          result?: { tools?: { name: string }[]; isError?: boolean; content?: { type: string; text?: string }[] }
          error?: { message?: string }
        }
        try {
          message = JSON.parse(line)
        } catch {
          continue // not protocol output (a startup banner, say)
        }
        if (message.error) return finish({ ok: false, error: message.error.message ?? 'The server reported an error.' })
        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (message.id === 2) {
          tools = (message.result?.tools ?? []).map((t) => t.name)
          if (probe && tools.includes(probe.tool)) {
            send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: probe.tool, arguments: probe.arguments } })
          } else {
            finish({ ok: true, tools })
          }
        } else if (message.id === 3) {
          if (message.result?.isError) {
            const text = (message.result.content ?? []).map((c) => c.text ?? '').join(' ').replace(/^###\s*Error\s*/i, '')
            finish({ ok: false, error: `It started, but ${probe?.doing ?? 'its test call'} failed: ${text.trim().slice(0, 600)}` })
          } else {
            finish({ ok: true, tools })
          }
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf-8')).slice(-1500)
    })
    child.on('error', (err) => finish({ ok: false, error: `It couldn't be started: ${err.message}` }))
    child.on('exit', (code) =>
      finish({ ok: false, error: `It stopped straight away (exit code ${code}).${tail(stderr)}` })
    )

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vibeapp', version: '0.1.0' } }
    })
  })
}

function tail(stderr: string): string {
  const text = stderr.trim()
  return text ? `\nIt printed:\n${text.slice(-800)}` : ''
}
