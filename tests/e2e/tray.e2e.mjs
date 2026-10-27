// End-to-end test of running VibeApp in the system tray, with no window:
// started with --tray, used entirely from a browser through Remote access,
// with the tray menu's status checked (the tests read it from a file, since a
// tray can't be clicked from a script), then started a second time (which
// must open the window instead of a second copy), and the window closed again
// (VibeApp must keep running).
//
//   npm run e2e:tray              (builds first)
//   npm run e2e:tray -- --no-build
//   npm run e2e:tray -- --packaged   (the installed-style build in release/win-unpacked)
//
// Your own projects, memory and settings are never touched.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = join(root, 'test-results', 'e2e-tray')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = 8400 + Math.floor(Math.random() * 500)
const APP_DEBUG = PORT + 600
const BROWSER_DEBUG = PORT + 601
const NTFY_PORT = PORT + 602

const packaged = process.argv.includes('--packaged')
const exe = join(root, 'release', 'win-unpacked', 'VibeApp.exe')
if (!packaged && !process.argv.includes('--no-build')) {
  console.log('Building the app...')
  const built = spawnSync('npx', ['electron-vite', 'build'], { cwd: root, stdio: 'inherit', shell: true })
  if (built.status !== 0) process.exit(built.status ?? 1)
}
rmSync(shots, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })

// ---- a test project and a fresh data folder ------------------------------------------

const project = mkdtempSync(join(tmpdir(), 'vibeapp-tray-project-'))
writeFileSync(join(project, 'shop.js'), '// Shop prices: potion costs 25 gold, sword costs 140 gold.\nmodule.exports = { potion: 25, sword: 140 }\n')
writeFileSync(join(project, 'index.html'), '<!doctype html><html><head><title>Tray Shop</title></head><body><h1>Tray Shop</h1></body></html>\n')
for (const args of [['init'], ['add', '-A'], ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'commit', '-m', 'start']]) {
  execFileSync('git', args, { cwd: project, stdio: 'ignore' })
}
const data = mkdtempSync(join(tmpdir(), 'vibeapp-tray-data-'))
const PROJECT_ID = 'tray-project'
writeFileSync(join(data, 'projects.json'), JSON.stringify({ projects: [{ id: PROJECT_ID, path: project, name: 'tray-game', lastOpened: new Date().toISOString() }] }))
writeFileSync(
  join(data, 'settings.json'),
  JSON.stringify({
    claudeModel: 'haiku',
    autoMemory: false,
    codeMap: false,
    smartRouting: false,
    codexReview: false,
    remoteAccess: 'local',
    remotePort: PORT,
    // Phone alerts go to a stand-in ntfy server on this computer.
    phoneAlerts: true,
    phoneAlertServer: `http://127.0.0.1:${NTFY_PORT}`,
    phoneAlertTopic: 'vibeapp-traytest'
  })
)
const code = () => JSON.parse(readFileSync(join(data, 'remote.json'), 'utf-8')).pairingCode
const trayMenu = () => {
  try {
    return JSON.parse(readFileSync(join(data, 'test-tray.json'), 'utf-8')).items.join(' | ')
  } catch {
    return ''
  }
}

// The stand-in ntfy: records what VibeApp would have sent to the phone.
const alerts = []
const ntfy = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    alerts.push({ topic: req.url, title: String(req.headers.title ?? ''), body })
    res.end('{}')
  })
})
await new Promise((r) => ntfy.listen(NTFY_PORT, '127.0.0.1', r))

const env = { ...process.env, VIBEAPP_USER_DATA: data, VIBEAPP_TEST_HOOKS: '1' }
delete env.ELECTRON_RUN_AS_NODE
const launch = (args) =>
  packaged
    ? spawn(exe, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(createRequire(import.meta.url)('electron'), ['.', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
const app = launch(['--tray', `--remote-debugging-port=${APP_DEBUG}`])
let appExited = false
app.on('exit', () => (appExited = true))

// ---- helpers ----------------------------------------------------------------------------

async function attach(port, match) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const target = targets.find(match)
  if (!target) return null
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let nextId = 0
  const pending = new Map()
  ws.onmessage = (raw) => {
    const m = JSON.parse(raw.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params = {}, timeoutMs = 30_000) =>
    new Promise((res, rej) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        rej(new Error(`No answer to ${method} within ${timeoutMs / 1000}s`))
      }, timeoutMs)
      pending.set(id, (m) => {
        clearTimeout(timer)
        res(m)
      })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        clearTimeout(timer)
        rej(err)
      }
    })
  await send('Runtime.enable')
  await send('Page.enable').catch(() => undefined)
  return {
    send,
    async evaluate(expression) {
      const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? 'evaluate failed')
      return m.result?.result?.value
    },
    close: () => ws.close()
  }
}

const appWindows = async () =>
  ((await (await fetch(`http://127.0.0.1:${APP_DEBUG}/json`)).json()) ?? []).filter((t) => t.type === 'page' && /index\.html/.test(t.url))

async function waitFor(page, expression, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      if (await page.evaluate(expression)) return
    } catch {
      // mid-navigation
    }
    await sleep(400)
  }
  throw new Error(`Timed out waiting for: ${what}`)
}

async function until(fn, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      if (await fn()) return
    } catch {
      // not yet
    }
    await sleep(500)
  }
  throw new Error(`Timed out waiting for: ${what}`)
}

const results = []
async function step(name, fn, page, limitMs = 300_000) {
  const start = Date.now()
  try {
    let timer
    await Promise.race([
      fn(),
      new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`step took longer than ${limitMs / 1000}s`)), limitMs)))
    ]).finally(() => clearTimeout(timer))
    results.push({ name, ok: true })
    console.log(`✔ ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`)
  } catch (err) {
    results.push({ name, ok: false, error: err.message })
    console.log(`✖ ${name}: ${err.message}`)
  }
  if (page) {
    const m = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    if (m?.result?.data) writeFileSync(join(shots, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`), Buffer.from(m.result.data, 'base64'))
  }
}

// ---- the steps ----------------------------------------------------------------------------

let browser
let browserProc
try {
  await step('started with --tray: no window, but Remote access is up and the tray menu is there', async () => {
    await until(async () => (await fetch(`http://127.0.0.1:${PORT}/login`)).status === 200, 'the Remote access server', 60_000)
    await sleep(4000)
    if ((await appWindows()).length) throw new Error('a window opened')
    await until(async () => /Open VibeApp/.test(trayMenu()) && /Remote access: on · 0 connected/.test(trayMenu()), 'the tray menu', 15_000)
    if (!/Copy pairing code \(\d{6}\)/.test(trayMenu())) throw new Error(`no pairing code in the menu: ${trayMenu()}`)
  })

  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p))
  browserProc = spawn(edge, ['--headless=new', `--remote-debugging-port=${BROWSER_DEBUG}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'vibeapp-tray-browser-'))}`, '--window-size=1400,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await attach(BROWSER_DEBUG, (t) => t.type === 'page').catch(() => null)
    if (!browser) await sleep(500)
  }

  await step('a browser pairs, and the tray shows it connected', async () => {
    await browser.send('Page.navigate', { url: `http://localhost:${PORT}/` })
    await waitFor(browser, `location.pathname === '/login' && !!document.getElementById('code')`, 'the pairing page')
    await browser.evaluate(`document.getElementById('code').value = ${JSON.stringify(code())}; document.getElementById('name').value = 'Tray test browser'; document.getElementById('f').requestSubmit(); 1`)
    await waitFor(browser, `[...document.querySelectorAll('.app-nav-tabs button')].some((b) => b.textContent === 'Projects' && !b.disabled)`, 'the app in the browser', 60_000)
    await until(async () => /1 connected/.test(trayMenu()), 'the tray to show 1 connected', 20_000)
  }, browser)

  await step('a request runs with no window: Claude asks a question, the tray shows it waiting, the browser answers', async () => {
    await browser.evaluate(`[...document.querySelectorAll('.app-nav-tabs button')].find((b) => b.textContent === 'Projects').click()`)
    await waitFor(browser, `!!document.querySelector('button.project-row')`, 'the project list')
    await browser.evaluate(`document.querySelector('button.project-row').click()`)
    await waitFor(browser, `!!document.querySelector('textarea.chat-input')`, 'the chat')
    await browser.evaluate(`document.querySelector('textarea.chat-input').focus()`)
    await browser.send('Input.insertText', {
      text: 'Before doing anything else, use your AskUserQuestion tool to ask me whether I prefer Red or Blue (exactly those two options). Then reply with only my choice.'
    })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await waitFor(browser, `!!document.querySelector('.question-card')`, 'the question in the browser', 180_000)
    await until(async () => /tray-game: waiting for you/.test(trayMenu()), 'the tray to show it waiting', 20_000)
    await until(async () => alerts.some((a) => a.topic === '/vibeapp-traytest' && /tray-game: Claude has a question/.test(a.title)), 'the phone alert', 15_000)
    await browser.evaluate(`[...document.querySelectorAll('.question-option')].find((b) => b.textContent.includes('Blue')).click()`)
    await sleep(300)
    await browser.evaluate(`document.querySelector('.question-submit').click()`)
    await waitFor(browser, `!document.querySelector('.chat-stop') && /blue/i.test([...document.querySelectorAll('.chat-item-assistant_text')].at(-1)?.innerText ?? '')`, 'the answer', 180_000)
    await until(async () => /Nothing running/.test(trayMenu()), 'the tray to show nothing running', 20_000)
    if ((await appWindows()).length) throw new Error('a window opened')
  }, browser)

  await step('a schedule shows in the tray, runs with no window and its phone alert arrives; Pause all hides it', async () => {
    const at = new Date(Date.now() + 35_000).toISOString()
    await browser.evaluate(
      `window.vibe.schedules.save('${PROJECT_ID}', { name: 'Quick check', action: { kind: 'request', text: 'Reply with just the word OK.', mode: 'ask' }, when: { kind: 'once', at: ${JSON.stringify(at)} } })`
    )
    await until(async () => /⏰ .*Quick check \(tray-game\)/.test(trayMenu()), 'the schedule in the tray menu', 20_000)
    await until(async () => alerts.some((a) => /tray-game: .*Quick check done/.test(a.title)), 'the phone alert for the scheduled run', 150_000)
    if ((await appWindows()).length) throw new Error('a window opened')
    // Another one, then pause everything: it leaves the menu.
    await browser.evaluate(
      `window.vibe.schedules.save('${PROJECT_ID}', { name: 'Later check', action: { kind: 'request', text: 'Reply OK.', mode: 'ask' }, when: { kind: 'every', minutes: 120 } })`
    )
    await until(async () => /Later check/.test(trayMenu()), 'the second schedule in the tray menu', 20_000)
    await browser.evaluate(`window.vibe.settings.update({ schedulesPaused: true })`)
    await until(async () => !/Later check/.test(trayMenu()) && /Pause all schedules/.test(trayMenu()), 'the paused tray menu', 20_000)
    await browser.evaluate(`window.vibe.settings.update({ schedulesPaused: false })`)
    for (const s of await browser.evaluate(`window.vibe.schedules.list('${PROJECT_ID}')`)) await browser.evaluate(`window.vibe.schedules.remove('${s.id}')`)
  }, browser)

  await step('starting VibeApp again opens the window instead of a second copy', async () => {
    const second = launch([])
    const exited = await Promise.race([new Promise((r) => second.once('exit', () => r(true))), sleep(20_000).then(() => false)])
    if (!exited) {
      second.kill()
      throw new Error('a second copy kept running')
    }
    await until(async () => (await appWindows()).length === 1, 'the window to open in the first copy', 20_000)
    if (appExited) throw new Error('the first copy quit')
  })

  await step('closing the window leaves VibeApp running in the tray', async () => {
    const win = await attach(APP_DEBUG, (t) => t.type === 'page' && /index\.html/.test(t.url))
    await waitFor(win, `[...document.querySelectorAll('.app-nav-tabs button')].some((b) => b.textContent === 'Projects')`, 'the window to load', 60_000)
    await win.evaluate(`setTimeout(() => window.close(), 100); 1`).catch(() => undefined)
    await until(async () => (await appWindows()).length === 0, 'the window to close', 15_000)
    await sleep(3000)
    if (appExited) throw new Error('VibeApp quit when the window closed')
    if ((await fetch(`http://127.0.0.1:${PORT}/login`)).status !== 200) throw new Error('Remote access stopped')
    if (!/Open VibeApp/.test(trayMenu())) throw new Error('the tray menu is gone')
  })
  await step('restoring a backup restarts VibeApp with the data as it was', async () => {
    await browser.evaluate(`window.vibe.todos.add('${PROJECT_ID}', 'Made before the backup')`)
    const made = await browser.evaluate(`window.vibe.backup.now()`)
    if (!made?.path?.startsWith(data)) throw new Error(`a test backup went outside the test folder: ${made?.path}`)
    await browser.evaluate(`window.vibe.todos.add('${PROJECT_ID}', 'Made after the backup')`)
    await browser.evaluate(`window.vibe.backup.restore(${JSON.stringify(made.path)})`).catch(() => undefined)
    await until(async () => appExited, 'the running VibeApp to close', 30_000)
    // It starts again by itself (with the same --tray start), with the backup in place.
    await sleep(3000)
    await until(async () => (await fetch(`http://127.0.0.1:${PORT}/login`)).status === 200, 'VibeApp to start again', 90_000)
    await browser.send('Page.reload')
    await waitFor(browser, `window.vibe?.host === 'browser'`, 'the app in the browser again', 60_000)
    const texts = (await browser.evaluate(`window.vibe.todos.list('${PROJECT_ID}')`)).map((t) => t.text)
    console.log(`  (to-dos after restoring: ${texts.join(', ')})`)
    if (!texts.includes('Made before the backup') || texts.includes('Made after the backup')) throw new Error(`not as it was: ${texts.join(', ')}`)
  }, browser)
} catch (err) {
  console.log(`✖ ${err.message}`)
  results.push({ name: 'setup', ok: false, error: err.message })
} finally {
  await Promise.race([browser?.send('Browser.close').catch(() => undefined), sleep(2000)])
  browserProc?.kill()
  app.kill()
  await sleep(1500)
  if (process.platform === 'win32' && app.pid) spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  // The copy that started again after the restore isn't a child of this script.
  if (process.platform === 'win32') {
    spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'remote-debugging-port=${APP_DEBUG}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' })
  }
  ntfy.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} tray steps passed${packaged ? ' (packaged app)' : ''}. Screenshots: ${shots}`)
  rmSync(data, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
  process.exit(failed.length ? 1 : 0)
}
