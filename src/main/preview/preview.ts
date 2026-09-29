import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { createReadStream, existsSync, readFileSync, statSync } from 'fs'
import { createServer, get as httpGet, type Server } from 'http'
import { createServer as createNetServer } from 'net'
import { extname, join, normalize, resolve, sep } from 'path'
import type { PreviewProblem, PreviewState } from '@shared/types'
import { isCliOnPath } from '../cli/execCli'
import { secretEnv } from '../secrets/vault'

const LOG_LIMIT = 300
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s'"]*/i
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g
const ERROR_LINE =
  /\b(error|exception|failed to compile|traceback|unhandled|cannot find module|syntaxerror|typeerror|referenceerror|module not found|eaddrinuse)\b/i
const NOT_AN_ERROR = /\b0 errors?\b|\bno errors\b|errorOverlay|\[vite\] connected/i

interface PlannedCommand {
  label: string
  /** A fixed command line (never built from user or project text). */
  commandLine?: string
  staticRoot?: string
  needsInstall: boolean
}

function planPreview(projectPath: string): PlannedCommand | string {
  const pkgPath = join(projectPath, 'package.json')
  if (existsSync(pkgPath)) {
    let pkg: { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object }
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    } catch {
      return "package.json couldn't be read, so VibeApp can't tell how to start this app."
    }
    const hasDeps =
      Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0
    const needsInstall = hasDeps && !existsSync(join(projectPath, 'node_modules'))
    if (pkg.scripts?.dev) return { label: 'npm run dev', commandLine: 'npm run dev', needsInstall }
    if (pkg.scripts?.start) return { label: 'npm start', commandLine: 'npm start', needsInstall }
  }
  if (existsSync(join(projectPath, 'index.html'))) {
    return { label: 'index.html', staticRoot: projectPath, needsInstall: false }
  }
  return 'Nothing to preview yet. Ask Claude to build a web page or app, and it will show up here.'
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

function probe(url: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const req = httpGet(url, (res) => {
      res.resume()
      resolveProbe(true)
    })
    req.on('error', () => resolveProbe(false))
    req.setTimeout(1500, () => {
      req.destroy()
      resolveProbe(false)
    })
  })
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
}

/** A minimal static file server for plain HTML projects, bound to localhost only. */
function startStaticServer(root: string): Promise<{ server: Server; url: string }> {
  const rootPath = resolve(root)
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    let filePath = normalize(join(rootPath, pathname))
    if (filePath !== rootPath && !filePath.startsWith(rootPath + sep)) {
      res.writeHead(403).end()
      return
    }
    if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html')
    if (!existsSync(filePath) || /[\\/]\.git([\\/]|$)/.test(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store'
    })
    createReadStream(filePath).pipe(res)
  })
  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveServer({ server, url: `http://localhost:${port}/` })
    })
  })
}

/**
 * Kills the server and everything it started (npm -> cmd -> node). On app
 * quit this must be synchronous: the app exits before an async taskkill gets
 * to run, and the dev server is left running with nothing to stop it.
 */
function killTree(child: ChildProcess, sync = false): void {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform !== 'win32') {
    child.kill()
    return
  }
  const args = ['/pid', String(child.pid), '/T', '/F']
  if (sync) {
    try {
      execFileSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 10_000 })
    } catch {
      // Already gone.
    }
  } else {
    spawn('taskkill', args, { windowsHide: true })
  }
}

/** Runs one project's preview: a dev server (or static server) plus error watching. */
export class PreviewRunner extends EventEmitter {
  private state: PreviewState = { status: 'idle' }
  private child: ChildProcess | undefined
  private staticServer: Server | undefined
  private log: string[] = []
  private pendingProblem: string[] | undefined
  private problemTimer: NodeJS.Timeout | undefined
  private probeTimer: NodeJS.Timeout | undefined
  private generation = 0

  constructor(
    private readonly projectId: string,
    private readonly projectPath: string
  ) {
    super()
  }

  getState(): PreviewState {
    return this.state
  }

  getLog(): string {
    return this.log.join('\n')
  }

  private setState(state: PreviewState): void {
    this.state = state
    this.emit('state', state)
  }

  private problem(problem: PreviewProblem): void {
    this.emit('problem', problem)
  }

  private appendLog(text: string): void {
    const lines = text.replace(ANSI_PATTERN, '').split(/\r?\n/).filter((l) => l.trim())
    for (const line of lines) {
      this.log.push(line)
      if (this.log.length > LOG_LIMIT) this.log.shift()

      if (this.state.status === 'starting') {
        const match = URL_PATTERN.exec(line)
        if (match) {
          const url = match[0].replace(/0\.0\.0\.0|127\.0\.0\.1|\[::1?\]/, 'localhost').replace(/[.,;)]+$/, '')
          this.setState({ status: 'running', command: this.state.command, url })
        }
      }

      // Group an error line with the lines right after it (stack traces,
      // code frames) into one problem report.
      if (this.pendingProblem) {
        if (this.pendingProblem.length < 20) this.pendingProblem.push(line)
      } else if (ERROR_LINE.test(line) && !NOT_AN_ERROR.test(line)) {
        this.pendingProblem = [line]
        this.problemTimer = setTimeout(() => {
          const message = this.pendingProblem?.join('\n') ?? ''
          this.pendingProblem = undefined
          if (message) this.problem({ source: 'server', message })
        }, 500)
      }
    }
  }

  async start(): Promise<void> {
    this.stop()
    const generation = ++this.generation
    const plan = planPreview(this.projectPath)
    if (typeof plan === 'string') {
      this.setState({ status: 'none', message: plan })
      return
    }

    if (plan.staticRoot) {
      const { server, url } = await startStaticServer(plan.staticRoot)
      if (generation !== this.generation) {
        server.close()
        return
      }
      this.staticServer = server
      this.setState({ status: 'running', command: plan.label, url })
      return
    }

    if (!(await isCliOnPath('npm'))) {
      this.setState({
        status: 'none',
        message: 'Node.js is needed to run this app. Install it from the Accounts tab, then try again.'
      })
      return
    }

    const port = await freePort()
    if (generation !== this.generation) return
    const commandLine = plan.needsInstall ? `npm install && ${plan.commandLine}` : plan.commandLine!
    this.log = []
    this.setState({ status: 'starting', command: plan.needsInstall ? `npm install, then ${plan.label}` : plan.label })

    const child = spawn(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', commandLine] : ['-c', commandLine], {
      cwd: this.projectPath,
      windowsHide: true,
      // PORT is honored by most Node servers that don't print their URL;
      // BROWSER=none stops dev servers from opening a browser tab.
      env: {
        ...process.env,
        ...secretEnv(this.projectId),
        PORT: String(port),
        BROWSER: 'none',
        FORCE_COLOR: '0',
        NO_COLOR: '1'
      }
    })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.appendLog(chunk.toString('utf-8')))
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(chunk.toString('utf-8')))
    child.on('error', (err) => this.appendLog(`Failed to start: ${err.message}`))
    child.on('exit', (code) => {
      if (this.child !== child) return // stopped on purpose
      this.child = undefined
      this.clearTimers()
      const command = this.state.status === 'idle' || this.state.status === 'none' ? plan.label : this.state.command
      this.setState({ status: 'crashed', command, exitCode: code })
      this.problem({
        source: 'server',
        message: `The app's server stopped (exit code ${code ?? 'unknown'}). Last output:\n${this.log.slice(-25).join('\n')}`
      })
    })

    // Servers that never print a URL: try the port we asked for.
    const startedAt = Date.now()
    const poll = async (): Promise<void> => {
      if (generation !== this.generation || this.state.status !== 'starting') return
      const url = `http://localhost:${port}/`
      if (Date.now() - startedAt > 5_000 && (await probe(url))) {
        if (generation === this.generation && this.state.status === 'starting') {
          this.setState({ status: 'running', command: this.state.command, url })
        }
        return
      }
      this.probeTimer = setTimeout(poll, 1_500)
    }
    this.probeTimer = setTimeout(poll, 1_500)
  }

  private clearTimers(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer)
    if (this.problemTimer) clearTimeout(this.problemTimer)
    this.pendingProblem = undefined
  }

  stop(sync = false): void {
    this.generation++
    this.clearTimers()
    const child = this.child
    this.child = undefined
    if (child) killTree(child, sync)
    this.staticServer?.close()
    this.staticServer = undefined
    if (this.state.status !== 'idle') this.setState({ status: 'idle' })
  }
}

const runners = new Map<string, PreviewRunner>()
export const previewEvents = new EventEmitter()

export function getPreview(projectId: string, projectPath: string): PreviewRunner {
  let runner = runners.get(projectId)
  if (!runner) {
    runner = new PreviewRunner(projectId, projectPath)
    runner.on('state', (state: PreviewState) => previewEvents.emit('state', projectId, state))
    runner.on('problem', (problem: PreviewProblem) => previewEvents.emit('problem', projectId, problem))
    runners.set(projectId, runner)
  }
  return runner
}

export function findPreview(projectId: string): PreviewRunner | undefined {
  return runners.get(projectId)
}

export function stopAllPreviews(): void {
  for (const runner of runners.values()) runner.stop(true)
}
