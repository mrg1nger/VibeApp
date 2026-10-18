// Checks VibeApp's screens on a phone-sized browser through Remote access:
// each screen must fit the width (no sideways scrolling), keep its main
// controls on screen and large enough to tap, and screenshots of each go to
// test-results/e2e-mobile/ to look at.
//
//   npm run e2e:mobile              (builds first)
//   npm run e2e:mobile -- --no-build
//
// Your own projects, memory and settings are never touched.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = join(root, 'test-results', 'e2e-mobile')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = 8400 + Math.floor(Math.random() * 500)
const BROWSER_DEBUG = PORT + 600
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }

if (!process.argv.includes('--no-build')) {
  const built = spawnSync('npx', ['electron-vite', 'build'], { cwd: root, stdio: 'inherit', shell: true })
  if (built.status !== 0) process.exit(built.status ?? 1)
}
rmSync(shots, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })

const project = mkdtempSync(join(tmpdir(), 'vibeapp-mobile-project-'))
writeFileSync(join(project, 'shop.js'), '// Shop prices: potion costs 25 gold, sword costs 140 gold.\nmodule.exports = { potion: 25, sword: 140 }\n')
writeFileSync(join(project, 'index.html'), '<!doctype html><html><head><title>Phone Shop</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Phone Shop</h1><p>Potions and swords.</p></body></html>\n')
for (const args of [['init'], ['add', '-A'], ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'commit', '-m', 'start']]) {
  execFileSync('git', args, { cwd: project, stdio: 'ignore' })
}
const data = mkdtempSync(join(tmpdir(), 'vibeapp-mobile-data-'))
const PROJECT_ID = 'mobile-project'
writeFileSync(join(data, 'projects.json'), JSON.stringify({ projects: [{ id: PROJECT_ID, path: project, name: 'phone-game', lastOpened: new Date().toISOString() }] }))
writeFileSync(join(data, 'settings.json'), JSON.stringify({ claudeModel: 'haiku', autoMemory: false, codeMap: false, remoteAccess: 'local', remotePort: PORT }))

const env = { ...process.env, VIBEAPP_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(createRequire(import.meta.url)('electron'), ['.'], { cwd: root, env, stdio: 'ignore' })

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
        rej(new Error(`no answer to ${method}`))
      }, timeoutMs)
      pending.set(id, (m) => {
        clearTimeout(timer)
        res(m)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  await send('Page.enable')
  return {
    send,
    async evaluate(expression) {
      const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? 'evaluate failed')
      return m.result?.result?.value
    }
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
    await sleep(300)
  }
  throw new Error(`Timed out waiting for: ${what}`)
}

/** Fits the phone's width? Lists anything sticking out, and visible controls too small to tap. */
const FIT_CHECK = `(() => {
  const w = window.innerWidth
  const tooWide = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (!r.width || getComputedStyle(el).position === 'fixed' && r.right <= w) continue
    if (r.right > w + 1 && !el.closest('[data-scroll-x], .chat-header-actions, .preview-body, pre, code, .usage-meters-row')) {
      tooWide.push((el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')) + ' ' + Math.round(r.right))
    }
  }
  const tiny = []
  for (const el of document.querySelectorAll('button, a, input, select, textarea')) {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    if (!r.width || s.visibility === 'hidden' || el.closest('[hidden]') || el.type === 'checkbox' || el.type === 'file') continue
    if (r.height < 30 && r.width < 30) tiny.push(el.tagName.toLowerCase() + ' "' + (el.textContent || el.placeholder || '').trim().slice(0, 20) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height))
  }
  return { scrollWidth: document.documentElement.scrollWidth, width: w, tooWide: [...new Set(tooWide)].slice(0, 8), tiny: tiny.slice(0, 8) }
})()`

const results = []
let browser
async function screen(name, prepare) {
  try {
    await prepare()
    await sleep(700)
    const fit = await browser.evaluate(FIT_CHECK)
    const m = await browser.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(shots, `${name}.png`), Buffer.from(m.result.data, 'base64'))
    const problems = []
    if (fit.scrollWidth > fit.width + 1) problems.push(`page is ${fit.scrollWidth}px wide on a ${fit.width}px screen`)
    if (fit.tooWide.length) problems.push(`sticking out: ${fit.tooWide.join(', ')}`)
    if (fit.tiny.length) problems.push(`too small to tap: ${fit.tiny.join(', ')}`)
    results.push({ name, ok: !problems.length, problems })
    console.log(`${problems.length ? '✖' : '✔'} ${name}${problems.length ? `: ${problems.join(' | ')}` : ''}`)
  } catch (err) {
    results.push({ name, ok: false, problems: [err.message] })
    console.log(`✖ ${name}: ${err.message}`)
  }
}

const click = (text, selector = 'button') =>
  browser.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent !== null && e.textContent.includes(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(text)}); el.click(); return true })()`)

let edgeProc
try {
  const base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 120; i++) {
    if ((await fetch(`${base}/login`).catch(() => null))?.status === 200) break
    await sleep(500)
  }
  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p))
  edgeProc = spawn(edge, ['--headless=new', `--remote-debugging-port=${BROWSER_DEBUG}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'vibeapp-mobile-browser-'))}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await attach(BROWSER_DEBUG, (t) => t.type === 'page').catch(() => null)
    if (!browser) await sleep(500)
  }
  await browser.send('Emulation.setDeviceMetricsOverride', PHONE)
  await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await browser.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  })

  await screen('01-pairing', async () => {
    await browser.send('Page.navigate', { url: `http://localhost:${PORT}/` })
    await waitFor(browser, `!!document.getElementById('code')`, 'the pairing page')
  })
  const code = JSON.parse(readFileSync(join(data, 'remote.json'), 'utf-8')).pairingCode
  await browser.evaluate(`document.getElementById('code').value = ${JSON.stringify(code)}; document.getElementById('name').value = 'Phone'; document.getElementById('f').requestSubmit(); 1`)
  await waitFor(browser, `[...document.querySelectorAll('.app-nav-tabs button')].some((b) => b.textContent === 'Projects' && !b.disabled)`, 'the app', 60_000)

  await screen('02-accounts', async () => {})
  await screen('03-projects', () => click('Projects', '.app-nav-tabs button'))
  await screen('04-chat', async () => {
    await click('phone-game', 'button.project-row')
    await waitFor(browser, `!!document.querySelector('textarea.chat-input')`, 'the chat')
  })
  await screen('05-chat-with-a-reply', async () => {
    await click('Ask', '.chat-mode-switch button')
    await browser.evaluate(`document.querySelector('textarea.chat-input').focus()`)
    await browser.send('Input.insertText', { text: 'What does the sword cost in shop.js? Answer in one short sentence.' })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await waitFor(browser, `document.querySelectorAll('.chat-item-assistant_text').length > 0 && !document.querySelector('.chat-stop')`, 'the answer', 180_000)
  })
  await screen('05b-plan-card', async () => {
    await click('Plan', '.chat-mode-switch button')
    await browser.evaluate(`document.querySelector('textarea.chat-input').focus()`)
    await browser.send('Input.insertText', { text: 'Add a function sellPrice(item) to shop.js that returns half the price, rounded down.' })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await waitFor(browser, `!!document.querySelector('.plan-card-pending') && !document.querySelector('.chat-stop')`, 'a proposed plan', 300_000)
    await browser.evaluate(`document.querySelector('.plan-card-pending').scrollIntoView({ block: 'end' })`)
  })
  await click('Cancel', '.plan-card-pending button')
  await click('Ask', '.chat-mode-switch button')
  await screen('06-preview', async () => {
    const tab = await browser.evaluate(`[...document.querySelectorAll('button')].some((b) => b.offsetParent && /^(👁 )?Preview$/.test(b.textContent.trim()) && b.closest('.mobile-pane-switch'))`)
    if (tab) await click('Preview', '.mobile-pane-switch button')
    await waitFor(browser, `!!document.querySelector('iframe.preview-frame') && document.querySelector('iframe.preview-frame').getBoundingClientRect().width > 200`, 'the preview to be visible', 60_000)
  })
  await screen('07-secrets-dialog', async () => {
    const back = await browser.evaluate(`!!document.querySelector('.mobile-pane-switch')`)
    if (back) await click('Chat', '.mobile-pane-switch button')
    await click('Secrets')
    await waitFor(browser, `!!document.querySelector('.modal')`, 'the dialog')
  })
  await browser.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await screen('08-chat-tab', () => click('Chat', '.app-nav-tabs button'))
  await screen('09-memory', () => click('Memory', '.app-nav-tabs button'))
  await screen('10-extensions', () => click('Extensions', '.app-nav-tabs button'))
  await screen('11-settings', () => click('Settings', '.app-nav-tabs button'))
} catch (err) {
  console.log(`✖ ${err.message}`)
  results.push({ name: 'setup', ok: false, problems: [err.message] })
} finally {
  try {
    await Promise.race([browser?.send('Browser.close'), sleep(2000)])
  } catch {
    // gone
  }
  edgeProc?.kill()
  app.kill()
  await sleep(1500)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} phone screens fit. Screenshots: ${shots}`)
  for (const dir of [data, project]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // still held; it's in the temp folder
    }
  }
  process.exit(failed.length ? 1 : 0)
}
