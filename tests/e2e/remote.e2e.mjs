// End-to-end test of Remote access: the real app with Remote access on, used
// through its HTTP API, from a real browser (headless Edge or Chrome), and
// through VibeApp's MCP server, then switched to local-network mode (HTTPS).
//
//   npm run e2e:remote              (builds first)
//   npm run e2e:remote -- --no-build
//   npm run e2e:remote -- --packaged   (the installed-style build in release/win-unpacked)
//
// Your own projects, memory and settings are never touched. Screenshots go
// to test-results/e2e-remote/.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = join(root, 'test-results', 'e2e-remote')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = 7800 + Math.floor(Math.random() * 600)
const APP_DEBUG = PORT + 700
const BROWSER_DEBUG = PORT + 701

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

const project = mkdtempSync(join(tmpdir(), 'vibeapp-remote-project-'))
writeFileSync(join(project, 'shop.js'), '// Shop prices: potion costs 25 gold, sword costs 140 gold.\nmodule.exports = { potion: 25, sword: 140 }\n')
writeFileSync(join(project, 'index.html'), '<!doctype html><html><head><title>Remote Shop</title></head><body><h1 id="title">Remote Shop</h1></body></html>\n')
for (const args of [['init'], ['add', '-A'], ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'commit', '-m', 'start']]) {
  execFileSync('git', args, { cwd: project, stdio: 'ignore' })
}
const data = mkdtempSync(join(tmpdir(), 'vibeapp-remote-data-'))
const PROJECT_ID = 'remote-project'
writeFileSync(join(data, 'projects.json'), JSON.stringify({ projects: [{ id: PROJECT_ID, path: project, name: 'remote-game', lastOpened: new Date().toISOString() }] }))
writeFileSync(
  join(data, 'settings.json'),
  JSON.stringify({ claudeModel: 'haiku', autoMemory: false, codeMap: false, smartRouting: false, remoteAccess: 'local', remotePort: PORT })
)
const code = () => JSON.parse(readFileSync(join(data, 'remote.json'), 'utf-8')).pairingCode

const env = { ...process.env, VIBEAPP_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = packaged
  ? spawn(exe, [`--remote-debugging-port=${APP_DEBUG}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(createRequire(import.meta.url)('electron'), ['.', `--remote-debugging-port=${APP_DEBUG}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
app.stderr.on('data', (d) => (appLog += d))

// ---- helpers ----------------------------------------------------------------------------

const base = `http://127.0.0.1:${PORT}`
async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const r = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json = null
  try {
    json = await r.json()
  } catch {
    // not JSON
  }
  return { status: r.status, json, headers: r.headers }
}

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
  // Every command has a time limit, so a browser that stops answering fails the step instead of hanging the run.
  const send = (method, params = {}, timeoutMs = 30_000) =>
    new Promise((res, rej) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        rej(new Error(`The browser did not answer ${method} within ${timeoutMs / 1000}s`))
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

let desktop
let browser
let browserProc
let token
let mcp

try {
  await until(async () => (await fetch(`${base}/login`)).status === 200, 'the Remote access server', 60_000)
  for (let i = 0; i < 60 && !desktop; i++) {
    desktop = await attach(APP_DEBUG, (t) => t.type === 'page' && /index\.html/.test(t.url)).catch(() => null)
    if (!desktop) await sleep(500)
  }

  await step('nothing works without pairing', async () => {
    if ((await api('/api/status')).status !== 401) throw new Error('status answered without a token')
    if ((await api('/api/invoke', { method: 'POST', body: { channel: 'vibe:project:list', args: [] } })).status !== 401) throw new Error('invoke worked without a token')
    const page = await fetch(`${base}/`, { redirect: 'manual' })
    if (page.status !== 302 || page.headers.get('location') !== '/login') throw new Error(`the app page answered ${page.status}`)
    if ((await api('/api/pair', { method: 'POST', body: { code: '123', name: 'x' } })).status !== 401) throw new Error('a wrong code was accepted')
  })

  await step('pairing gives a token that works, and the code changes', async () => {
    const first = code()
    const r = await api('/api/pair', { method: 'POST', body: { code: first, name: 'API test' } })
    if (r.status !== 200 || !r.json?.token) throw new Error(`pairing failed: ${JSON.stringify(r.json)}`)
    token = r.json.token
    if (!/HttpOnly/.test(r.headers.get('set-cookie') ?? '')) throw new Error('the session cookie is not HttpOnly')
    if (code() === first) throw new Error('the pairing code was not replaced')
    const list = await api('/api/invoke', { method: 'POST', token, body: { channel: 'vibe:project:list', args: [] } })
    if (!list.json?.result?.some((p) => p.name === 'remote-game')) throw new Error(`projects: ${JSON.stringify(list.json)}`)
  })

  await step('a remote caller cannot change Remote access or use another site\'s cookies', async () => {
    const revoke = await api('/api/invoke', { method: 'POST', token, body: { channel: 'vibe:remote:revokeAll', args: [] } })
    if (revoke.status !== 403) throw new Error(`revokeAll answered ${revoke.status}`)
    const settings = await api('/api/invoke', { method: 'POST', token, body: { channel: 'vibe:settings:update', args: [{ remoteAccess: 'off', autoAsk: false }] } })
    if (settings.json?.result?.remoteAccess !== 'local' || settings.json?.result?.autoAsk !== false) throw new Error(`settings: ${JSON.stringify(settings.json?.result)}`)
    const csrf = await fetch(`${base}/api/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `vibeapp_session=${token}`, Origin: 'http://evil.example' },
      body: JSON.stringify({ channel: 'vibe:project:list', args: [] })
    })
    if (csrf.status !== 403) throw new Error(`a cross-site request answered ${csrf.status}`)
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`, { headers: { Origin: 'http://evil.example' } })
    const opened = await new Promise((r) => {
      ws.onopen = () => r(true)
      ws.onerror = () => r(false)
      ws.onclose = () => r(false)
    })
    if (opened) throw new Error('a WebSocket from another site was accepted')
  })

  await step('read-only mode blocks actions but allows reading', async () => {
    await desktop.evaluate(`window.vibe.settings.update({ remoteReadOnly: true })`)
    const send = await api('/api/invoke', { method: 'POST', token, body: { channel: 'vibe:chat:ask', args: [PROJECT_ID, project, 'hi'] } })
    if (send.status !== 403) throw new Error(`a read-only ask answered ${send.status}`)
    const read = await api('/api/invoke', { method: 'POST', token, body: { channel: 'vibe:chat:loadTranscript', args: [PROJECT_ID] } })
    if (read.status !== 200) throw new Error(`reading answered ${read.status}`)
    await desktop.evaluate(`window.vibe.settings.update({ remoteReadOnly: false })`)
  })

  // ---- a real browser ----

  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p))
  const profile = mkdtempSync(join(tmpdir(), 'vibeapp-remote-browser-'))
  browserProc = spawn(edge, ['--headless=new', `--remote-debugging-port=${BROWSER_DEBUG}`, `--user-data-dir=${profile}`, '--window-size=1400,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await attach(BROWSER_DEBUG, (t) => t.type === 'page').catch(() => null)
    if (!browser) await sleep(500)
  }

  /** Starts a headless browser with a profile folder (kept between restarts, like a real one). */
  async function openBrowser(dir, port) {
    const proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--window-size=1400,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
    let page = null
    for (let i = 0; i < 60 && !page; i++) {
      page = await attach(port, (t) => t.type === 'page').catch(() => null)
      if (!page) await sleep(500)
    }
    return { proc, page }
  }
  /** Closes the browser the way a person would, letting it save its cookies, and waits for it to exit. */
  async function closeBrowser(b) {
    const exited = new Promise((r) => b.proc.once('exit', r))
    await Promise.race([b.page?.send('Browser.close').catch(() => undefined), sleep(3000)])
    await Promise.race([exited, sleep(20_000)])
    b.proc.kill()
    await sleep(1000)
  }
  async function pairIn(page, remember, name) {
    await page.send('Page.navigate', { url: `http://localhost:${PORT}/` })
    await waitFor(page, `location.pathname === '/login' && !!document.getElementById('code')`, 'the pairing page')
    await page.evaluate(`document.getElementById('code').value = ${JSON.stringify(code())}; document.getElementById('name').value = ${JSON.stringify(name)}; document.getElementById('remember').checked = ${remember}; document.getElementById('f').requestSubmit(); 1`)
    await waitFor(page, `window.vibe?.host === 'browser'`, 'the app in the browser', 30_000)
  }

  await step('a browser is sent to the pairing page, pairs, and gets the app', async () => {
    await pairIn(browser, true, 'Main browser')
    await waitFor(browser, `[...document.querySelectorAll('.app-nav-tabs button')].some((b) => b.textContent === 'Projects' && !b.disabled)`, 'the app to be ready', 60_000)
    await browser.send('Network.enable')
    const { result } = await browser.send('Network.getCookies', { urls: [`http://localhost:${PORT}/`] })
    const cookie = result?.cookies?.find((c) => c.name === 'vibeapp_session')
    if (!cookie || cookie.session || cookie.expires * 1000 < Date.now() + 300 * 86_400_000) {
      throw new Error(`a remembered device should get a long-lasting cookie: ${JSON.stringify(cookie)}`)
    }
  }, browser)

  await step('a remembered browser is still paired after it is closed and opened again', async () => {
    await closeBrowser({ proc: browserProc, page: browser })
    ;({ proc: browserProc, page: browser } = await openBrowser(profile, BROWSER_DEBUG))
    await browser.send('Page.navigate', { url: `http://localhost:${PORT}/` })
    await waitFor(browser, `window.vibe?.host === 'browser' || location.pathname === '/login'`, 'the page to load', 30_000)
    if (await browser.evaluate(`location.pathname === '/login'`)) throw new Error('it asked for a pairing code again')
    await waitFor(browser, `[...document.querySelectorAll('.app-nav-tabs button')].some((b) => b.textContent === 'Projects' && !b.disabled)`, 'the app to be ready', 60_000)
  }, browser)

  await step('a browser that was not remembered asks again after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibeapp-remote-borrowed-'))
    let other = await openBrowser(dir, BROWSER_DEBUG + 1)
    await pairIn(other.page, false, 'Borrowed browser')
    const status = await desktop.evaluate(`window.vibe.remote.status()`)
    if (status.devices.find((d) => d.name === 'Borrowed browser')?.remember !== false) throw new Error('not marked as "until its browser closes"')
    await closeBrowser(other)
    other = await openBrowser(dir, BROWSER_DEBUG + 1)
    await other.page.send('Page.navigate', { url: `http://localhost:${PORT}/` })
    await waitFor(other.page, `location.pathname === '/login'`, 'the pairing page', 20_000)
    await closeBrowser(other)
  })

  await step('the desktop app shows the browser as connected', async () => {
    await until(async () => (await desktop.evaluate(`window.vibe.remote.status()`)).devices.some((d) => d.online && d.name === 'Main browser'), 'the device to show as online', 15_000)
  })

  await step('the browser opens the project and shows its live preview', async () => {
    await browser.evaluate(`[...document.querySelectorAll('.app-nav-tabs button')].find((b) => b.textContent === 'Projects').click()`)
    await waitFor(browser, `!!document.querySelector('button.project-row')`, 'the project list')
    await browser.evaluate(`document.querySelector('button.project-row').click()`)
    await waitFor(browser, `!!document.querySelector('textarea.chat-input')`, 'the chat')
    await waitFor(browser, `!!document.querySelector('iframe.preview-frame')`, 'the preview frame', 60_000)
    const frame = await until(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${BROWSER_DEBUG}/json`)).json()
      return targets.some((t) => t.type === 'iframe' && /^http:\/\/localhost:\d+\/$/.test(t.url)) || (await browser.evaluate(`!!document.querySelector('iframe.preview-frame')?.src`))
    }, 'the relayed preview', 20_000)
    void frame
  }, browser)

  await step('Point works in the relayed preview', async () => {
    await sleep(1500)
    await browser.evaluate(`[...document.querySelectorAll('.preview-toolbar button')].find((b) => b.textContent.includes('Point')).click()`)
    await sleep(800)
    const box = await browser.evaluate(`(() => { const r = document.querySelector('iframe.preview-frame').getBoundingClientRect(); return { x: r.x + 60, y: r.y + 30 } })()`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await browser.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    }
    await waitFor(browser, `/Remote Shop/.test(document.querySelector('.picked-chip')?.innerText ?? '')`, 'the picked element', 10_000)
    await browser.evaluate(`document.querySelector('.picked-chip button').click()`)
  }, browser)

  await step('a question asked in the browser is answered (and the work happens on the computer)', async () => {
    await browser.evaluate(`[...document.querySelectorAll('.chat-mode-switch button')].find((b) => b.textContent.includes('Ask')).click()`)
    await browser.evaluate(`document.querySelector('textarea.chat-input').focus()`)
    await browser.send('Input.insertText', { text: 'What does the sword cost in shop.js? Answer with the number.' })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await waitFor(browser, `/140/.test([...document.querySelectorAll('.chat-item-assistant_text')].at(-1)?.innerText ?? '')`, 'the answer', 180_000)
    const transcript = await api('/api/invoke', { method: 'POST', token, body: { channel: 'vibe:chat:loadTranscript', args: [PROJECT_ID] } })
    if (!JSON.stringify(transcript.json).includes('What does the sword cost')) throw new Error('the question is not in the saved chat')
  }, browser)

  await step('the browser can browse folders to open a project', async () => {
    await browser.evaluate(`[...document.querySelectorAll('.app-nav-tabs button')].find((b) => b.textContent === 'Projects').click()`)
    await waitFor(browser, `[...document.querySelectorAll('button')].some((b) => b.textContent === 'Open a folder')`, 'the projects screen')
    await browser.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Open a folder').click()`)
    await waitFor(browser, `[...document.querySelectorAll('.folder-list button')].some((b) => /Home/.test(b.textContent))`, 'the folder list')
    await browser.evaluate(`[...document.querySelectorAll('.folder-list button')].find((b) => /Home/.test(b.textContent)).click()`)
    await waitFor(browser, `document.querySelector('.folder-path')?.textContent.length > 3 && document.querySelectorAll('.folder-list button').length > 1`, 'the home folder contents')
    await browser.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  }, browser)

  // ---- the MCP server (what Claude Code would use) ----

  await step('the MCP server lists projects and gets an answer through VibeApp', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(data, 'vibeapp-mcp.cjs')],
      env: { ...process.env, VIBEAPP_API_FILE: join(data, 'remote-api.json') }
    })
    mcp = new Client({ name: 'vibeapp-e2e', version: '1.0.0' })
    await mcp.connect(transport)
    const tools = (await mcp.listTools()).tools.map((t) => t.name)
    for (const t of ['list_projects', 'send_message', 'wait_for_reply', 'answer_prompt', 'read_chat', 'memory', 'usage', 'stop', 'compact']) {
      if (!tools.includes(t)) throw new Error(`missing tool ${t}`)
    }
    const text = (r) => r.content.map((c) => c.text).join('\n')
    const list = text(await mcp.callTool({ name: 'list_projects', arguments: {} }))
    if (!/remote-game/.test(list)) throw new Error(list)
    const reply = text(await mcp.callTool({ name: 'send_message', arguments: { project: 'remote-game', message: 'How much does the potion cost in shop.js? Number only.', mode: 'ask', timeout_seconds: 180 } }))
    if (!/25/.test(reply) || !/Finished/.test(reply)) throw new Error(reply)
    const chat = text(await mcp.callTool({ name: 'read_chat', arguments: { project: 'remote-game', last: 10 } }))
    if (!/potion/.test(chat)) throw new Error(chat)
    const usage = text(await mcp.callTool({ name: 'usage', arguments: {} }))
    if (!/claude:/.test(usage) || !/codex:/.test(usage)) throw new Error(usage)
  })

  await step('disconnecting the browser in the desktop app sends it back to pairing', async () => {
    const status = await desktop.evaluate(`window.vibe.remote.status()`)
    const device = status.devices.find((d) => d.name === 'Main browser')
    await desktop.evaluate(`window.vibe.remote.revoke(${JSON.stringify(device.id)})`)
    await waitFor(browser, `location.pathname === '/login'`, 'the browser to be sent to pairing', 20_000)
  }, browser)

  // ---- local-network mode: HTTPS ----

  await step('local-network mode serves HTTPS with its own certificate, and the MCP server still works', async () => {
    await desktop.evaluate(`window.vibe.settings.update({ remoteAccess: 'lan' })`)
    const api = () => JSON.parse(readFileSync(join(data, 'remote-api.json'), 'utf-8'))
    await until(() => api().url.startsWith('https://') && !!api().ca, 'the HTTPS address', 30_000)
    const status = await new Promise((done, fail) => {
      const req = httpsRequest(`https://127.0.0.1:${PORT}/login`, { ca: api().ca }, (res) => done(res.statusCode))
      req.on('error', fail)
      req.end()
    })
    if (status !== 200) throw new Error(`HTTPS answered ${status}`)
    const plain = await fetch(`http://127.0.0.1:${PORT}/login`).then((r) => r.status).catch(() => 'refused')
    if (plain === 200) throw new Error('plain HTTP still answers in local-network mode')
    const remote = await desktop.evaluate(`window.vibe.remote.status()`)
    if (!remote.urls.some((u) => u.startsWith('https://'))) throw new Error(`addresses: ${remote.urls}`)
    // A new MCP process picks up the new address and certificate.
    await mcp.close()
    mcp = new Client({ name: 'vibeapp-e2e-2', version: '1.0.0' })
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(data, 'vibeapp-mcp.cjs')], env: { ...process.env, VIBEAPP_API_FILE: join(data, 'remote-api.json') } }))
    const list = (await mcp.callTool({ name: 'list_projects', arguments: {} })).content.map((c) => c.text).join('\n')
    if (!/remote-game/.test(list)) throw new Error(list)
  })

  await step('switching Remote access off closes the server', async () => {
    await desktop.evaluate(`window.vibe.settings.update({ remoteAccess: 'off' })`)
    await until(async () => {
      const r = await new Promise((done) => {
        const req = httpsRequest(`https://127.0.0.1:${PORT}/login`, { rejectUnauthorized: false }, (res) => done(res.statusCode))
        req.on('error', () => done('refused'))
        req.end()
      })
      return r === 'refused'
    }, 'the server to close', 15_000)
  })
} catch (err) {
  console.log(`✖ ${err.message}`)
  results.push({ name: 'setup', ok: false, error: err.message })
} finally {
  await mcp?.close().catch(() => undefined)
  try {
    await Promise.race([browser?.send('Browser.close'), sleep(2000)])
  } catch {
    // gone
  }
  browserProc?.kill()
  try {
    await Promise.race([desktop?.send('Browser.close'), sleep(2000)])
  } catch {
    // gone
  }
  app.kill()
  await sleep(1500)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} remote steps passed. Screenshots: ${shots}`)
  writeFileSync(join(shots, 'app-log.txt'), appLog)
  for (const dir of [data, project]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // still held by a process; it's in the temp folder
    }
  }
  process.exit(failed.length ? 1 : 0)
}
