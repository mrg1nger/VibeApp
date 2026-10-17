// Runs VibeApp's tests outside Electron.
//
//   npm test                 fast unit tests (no network, no usage)
//   npm run smoke            smoke tests against the real Claude Code and Codex CLIs
//                            (needs both logged in; uses a little plan usage, mostly Haiku)
//   npm run smoke -- takeover   only the smoke files whose name contains "takeover"
//
// Each test file is bundled with esbuild (Electron swapped for a small stand-in,
// the app's data folder pointed at a temp dir) next to the built main process,
// so paths like the memory server's resolve as they do in the app, then run
// with Node's built-in test runner.

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const kind = process.argv[2] === 'smoke' ? 'smoke' : 'unit'
const filter = process.argv[3]
const testDir = join(root, 'tests', kind)
const outDir = join(root, 'out', 'main')

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts') && (!filter || f.includes(filter)))
  .sort()
if (!files.length) {
  console.error(`No ${kind} tests${filter ? ` matching "${filter}"` : ''}.`)
  process.exit(1)
}

// Smoke tests start the memory server, which is built with the app.
if (kind === 'smoke' && !existsSync(join(outDir, 'memory', 'memoryServer.cjs'))) {
  console.log('Building the app first (the memory server is part of the build)...')
  const built = spawnSync('npx', ['electron-vite', 'build'], { cwd: root, stdio: 'inherit', shell: true })
  if (built.status !== 0) process.exit(built.status ?? 1)
}

const bundles = []
try {
  for (const file of files) {
    const out = join(outDir, `_test-${kind}-${file.replace(/\.ts$/, '.cjs')}`)
    await build({
      entryPoints: [join(testDir, file)],
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      sourcemap: 'inline',
      logLevel: 'error',
      alias: {
        electron: join(root, 'tests', 'support', 'electron-stub.cjs'),
        '@shared': join(root, 'shared')
      },
      external: ['node:sqlite', '@anthropic-ai/claude-agent-sdk', 'node-pty']
    })
    bundles.push(out)
  }

  const data = mkdtempSync(join(tmpdir(), `vibeapp-${kind}-data-`))
  const run = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', '--test-timeout=1200000', '--no-warnings=ExperimentalWarning', ...bundles],
    { cwd: root, stdio: 'inherit', env: { ...process.env, VIBEAPP_TEST_DATA: data } }
  )
  rmSync(data, { recursive: true, force: true })
  process.exitCode = run.status ?? 1
} finally {
  for (const b of bundles) rmSync(b, { force: true })
}
