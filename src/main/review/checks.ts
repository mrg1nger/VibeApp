import { execFile, spawn } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { extname, join } from 'path'
import { promisify } from 'util'
import { trackChild } from '../cli/codexExec'

const execFileAsync = promisify(execFile)

const TEST_TIMEOUT_MS = 90_000
const MAX_SYNTAX_FILES = 25
const MAX_FILE_BYTES = 500_000

export interface CheckOutcome {
  /** true: everything checked passed; false: something failed; null: nothing applicable to check. */
  ok: boolean | null
  /** One short line per thing checked, ready to show an agent. */
  summary: string
}

// Node reports a project script written as an ES module (import/export) as a
// syntax error when it's checked as a plain script; that's not a real error.
const LOOKS_LIKE_MODULE = /Cannot use import statement|Unexpected token 'export'|Cannot use 'import.meta'|await is only valid/i

async function checkScriptSyntax(projectPath: string, rel: string): Promise<string | null> {
  const full = join(projectPath, rel)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  try {
    await execFileAsync(process.execPath, ['--check', full], { env, windowsHide: true, timeout: 15_000 })
    return null
  } catch (err) {
    const message = String((err as { stderr?: string }).stderr ?? (err as Error).message)
    if (LOOKS_LIKE_MODULE.test(message)) {
      // Try again as a module, from stdin.
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, ['--input-type=module', '--check'], { env, windowsHide: true })
          let stderr = ''
          child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
          child.on('error', reject)
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))))
          child.stdin.end(readFileSync(full))
        })
        return null
      } catch (moduleErr) {
        return `${rel}: ${firstErrorLine(String((moduleErr as Error).message))}`
      }
    }
    return `${rel}: ${firstErrorLine(message)}`
  }
}

function firstErrorLine(message: string): string {
  const lines = message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return (lines.find((l) => /Error/.test(l)) ?? lines[0] ?? 'syntax error').slice(0, 200)
}

function checkJson(projectPath: string, rel: string): string | null {
  try {
    JSON.parse(readFileSync(join(projectPath, rel), 'utf-8'))
    return null
  } catch (err) {
    return `${rel}: invalid JSON (${(err as Error).message.slice(0, 120)})`
  }
}

function projectTestScript(projectPath: string): { command: string; blockedReason?: string } | null {
  const pkgPath = join(projectPath, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>
      dependencies?: object
      devDependencies?: object
    }
    const script = pkg.scripts?.test
    // npm's default placeholder isn't a test.
    if (!script || /no test specified/i.test(script)) return null
    const hasDeps = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0
    if (hasDeps && !existsSync(join(projectPath, 'node_modules'))) {
      return { command: 'npm test', blockedReason: 'dependencies are not installed yet' }
    }
    return { command: 'npm test' }
  } catch {
    return null
  }
}

function runProjectTests(projectPath: string): Promise<{ passed: boolean; tail: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    // A fixed command line, never built from project or user text.
    const child = trackChild(
      spawn(isWin ? 'cmd.exe' : 'sh', isWin ? ['/d', '/s', '/c', 'npm test'] : ['-c', 'npm test'], {
        cwd: projectPath,
        windowsHide: true,
        env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }
      })
    )
    let output = ''
    let done = false
    const finish = (passed: boolean, timedOut: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ passed, tail: output.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-700), timedOut })
    }
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf-8')).slice(-4000)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', () => finish(false, false))
    child.on('exit', (code) => finish(code === 0, false))
    const timer = setTimeout(() => {
      if (child.pid) {
        if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill()
      }
      finish(false, true)
    }, TEST_TIMEOUT_MS)
  })
}

/**
 * Quick, local checks on files an agent just changed: script syntax, JSON
 * validity, and the project's own `npm test` if it has one. Cheap for
 * VibeApp to run and much cheaper than an agent spending turns reading the
 * files back to be sure.
 */
export async function verifyChanges(projectPath: string, changed: string[]): Promise<CheckOutcome> {
  const passes: string[] = []
  const failures: string[] = []

  const scripts = changed
    .filter((p) => ['.js', '.mjs', '.cjs'].includes(extname(p).toLowerCase()))
    .filter((p) => {
      try {
        return statSync(join(projectPath, p)).size <= MAX_FILE_BYTES
      } catch {
        return false // deleted
      }
    })
    .slice(0, MAX_SYNTAX_FILES)
  if (scripts.length) {
    const results = await Promise.all(scripts.map((p) => checkScriptSyntax(projectPath, p)))
    const bad = results.filter((r): r is string => r !== null)
    failures.push(...bad.map((b) => `syntax error in ${b}`))
    if (scripts.length > bad.length) passes.push(`syntax OK in ${scripts.length - bad.length} script file${scripts.length - bad.length === 1 ? '' : 's'}`)
  }

  const jsonFiles = changed.filter((p) => extname(p).toLowerCase() === '.json' && existsSync(join(projectPath, p)))
  for (const p of jsonFiles.slice(0, 10)) {
    const problem = checkJson(projectPath, p)
    if (problem) failures.push(problem)
  }
  if (jsonFiles.length && !failures.some((f) => f.includes('invalid JSON'))) passes.push(`${jsonFiles.length} JSON file${jsonFiles.length === 1 ? '' : 's'} valid`)

  // Don't run the project's tests on top of a syntax error: it would only repeat it.
  if (!failures.length && changed.length) {
    const test = projectTestScript(projectPath)
    if (test?.blockedReason) {
      passes.push(`npm test skipped (${test.blockedReason})`)
    } else if (test) {
      const run = await runProjectTests(projectPath)
      if (run.timedOut) failures.push(`npm test did not finish within ${TEST_TIMEOUT_MS / 1000}s`)
      else if (!run.passed) failures.push(`npm test failed:\n${run.tail}`)
      else passes.push('npm test passed')
    }
  }

  if (failures.length) return { ok: false, summary: `checks FAILED: ${failures.join('; ')}` }
  if (passes.length) return { ok: true, summary: `checks passed: ${passes.join(', ')}` }
  return { ok: null, summary: '' }
}
