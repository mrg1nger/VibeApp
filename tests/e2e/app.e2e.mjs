// End-to-end test of the real app: launches Electron with its own data folder
// and a fresh test project, and drives the screens through the Chrome
// DevTools protocol (clicks and typing, as a person would).
//
//   npm run e2e                    build, then test the development build
//   npm run e2e -- --packaged      test the installed-style build in release/win-unpacked
//                                  (run `npm run package` first)
//   npm run e2e -- --no-build      skip the build step
//
// Needs Claude Code and Codex installed and logged in. Takes several minutes
// and uses a little of both plans (Claude runs on Haiku). Screenshots of each
// step are saved to test-results/e2e/. Your own projects, memory and settings are never
// touched.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const packaged = process.argv.includes('--packaged')
const shots = join(root, 'test-results', packaged ? 'e2e-packaged' : 'e2e')
const PORT = 9400 + Math.floor(Math.random() * 400)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- setup ----------------------------------------------------------------------

const exe = join(root, 'release', 'win-unpacked', 'VibeApp.exe')
if (packaged && !existsSync(exe)) {
  console.error(`No packaged app at ${exe}. Run \`npm run package\` first.`)
  process.exit(1)
}
if (!packaged && !process.argv.includes('--no-build')) {
  console.log('Building the app...')
  const built = spawnSync('npx', ['electron-vite', 'build'], { cwd: root, stdio: 'inherit', shell: true })
  if (built.status !== 0) process.exit(built.status ?? 1)
}
rmSync(shots, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })

const PAGE = `<!doctype html><html><head><title>E2E Shop</title></head><body>
<h1 id="title">E2E Shop</h1><p>Potions and swords for sale.</p></body></html>
`
const project = mkdtempSync(join(tmpdir(), 'vibeapp-e2e-project-'))
writeFileSync(join(project, 'shop.js'), '// Shop prices: potion costs 25 gold, sword costs 140 gold.\nmodule.exports = { potion: 25, sword: 140 }\n')
writeFileSync(join(project, 'battle.js'), '// Battle damage formula: damage = attack * 2 - defence\nmodule.exports = (a, d) => a * 2 - d\n')
writeFileSync(join(project, 'index.html'), PAGE)
for (const args of [['init'], ['add', '-A'], ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'commit', '-m', 'start']]) {
  execFileSync('git', args, { cwd: project, stdio: 'ignore' })
}
const originalShop = readFileSync(join(project, 'shop.js'), 'utf-8')

const data = mkdtempSync(join(tmpdir(), 'vibeapp-e2e-data-'))
const PROJECT_ID = 'e2e-project'
const E2E_CODEX_MODEL = process.env.VIBEAPP_E2E_CODEX_MODEL ?? ''
writeFileSync(
  join(data, 'projects.json'),
  JSON.stringify({ projects: [{ id: PROJECT_ID, path: project, name: 'e2e-game', lastOpened: new Date().toISOString() }] })
)
writeFileSync(
  join(data, 'settings.json'),
  JSON.stringify({
    claudeModel: 'haiku', // cheap
    agentBalance: 'claude', // Claude does the edit itself, so Codex reviews it
    smartRouting: false, // no "quick edit" shortcut that would skip the review
    codexReview: true,
    autoMemory: false,
    codeMap: false,
    // Optional: when OpenAI is turning the usual Codex model away, test with another one.
    codexModel: E2E_CODEX_MODEL || null
  })
)

/** A small solid-colour PNG, for the image test. */
function solidPng(r, g, b, size = 32) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const tb = Buffer.concat([Buffer.from(type), body])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(tb))
    return Buffer.concat([len, tb, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([r, g, b]))])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
const redImage = join(data, 'red-square.png')
writeFileSync(redImage, solidPng(220, 20, 20))

// Editors such as VS Code set this for the processes they start, and it would
// run Electron as plain Node instead of opening the app.
const env = { ...process.env, VIBEAPP_USER_DATA: data, VIBEAPP_TEST_HOOKS: '1', ELECTRON_ENABLE_LOGGING: '1' }
delete env.ELECTRON_RUN_AS_NODE
const command = packaged ? exe : createRequire(import.meta.url)('electron')
const appArgs = packaged ? [`--remote-debugging-port=${PORT}`] : ['.', `--remote-debugging-port=${PORT}`]
const app = spawn(command, appArgs, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
app.stderr.on('data', (d) => (appLog += d))

// ---- DevTools connections ----------------------------------------------------------

async function targets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
}

/** Connects to one page (the app window, or the preview's embedded page). */
async function attach(match) {
  const target = (await targets()).find(match)
  if (!target) return null
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let nextId = 0
  const pending = new Map()
  const errors = []
  ws.onmessage = (raw) => {
    const m = JSON.parse(raw.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  await send('Page.enable').catch(() => undefined)
  return {
    send,
    errors,
    close: () => ws.close(),
    async evaluate(expression) {
      const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? 'evaluate failed')
      return m.result?.result?.value
    }
  }
}

let page
for (let i = 0; i < 120 && !page; i++) {
  try {
    page = await attach((t) => t.type === 'page' && /index\.html|localhost:5173/.test(t.url))
  } catch {
    // not up yet
  }
  if (!page) await sleep(500)
}
const cdp = (method, params) => page.send(method, params)
const evaluate = (expression) => page.evaluate(expression)

async function waitFor(expression, what, timeoutMs = 30_000, on = page) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      if (await on.evaluate(expression)) return
    } catch {
      // page mid-render
    }
    await sleep(400)
  }
  throw new Error(`Timed out waiting for: ${what}`)
}

/** Clicks the first visible, enabled element (a button by default) whose text contains `text`. */
async function click(text, selector = 'button') {
  const ok = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => e.offsetParent !== null && !e.disabled && e.textContent.includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)
  if (!ok) throw new Error(`No clickable "${text}" (${selector})`)
  await sleep(300)
}

/** Fills a React-controlled input, as typing would. */
async function fill(selector, value) {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    el.focus()
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
}

const pressEscape = () => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)

/** Types into the message box and presses Enter. */
async function type(text) {
  await waitFor(`!!document.querySelector('textarea.chat-input') && !document.querySelector('textarea.chat-input').disabled`, 'the message box')
  await evaluate(`document.querySelector('textarea.chat-input').focus()`)
  await cdp('Input.insertText', { text })
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}

/** Sends a chat message and waits until the request has started. */
async function send(text) {
  await type(text)
  await waitFor(`!!document.querySelector('.chat-stop')`, 'the request to start', 15_000)
}

/** Waits for the current request (including any Codex review) to finish. */
function idle(timeoutMs = 600_000) {
  return waitFor(`!document.querySelector('.chat-stop') && !document.querySelector('.chat-item-thinking')`, 'the request to finish', timeoutMs)
}

const chatText = () => evaluate(`document.querySelector('.chat-log')?.innerText ?? ''`)
const lastReply = () =>
  evaluate(`[...document.querySelectorAll('.chat-item-assistant_text')].at(-1)?.innerText ?? ''`)

async function shot(name) {
  const m = await cdp('Page.captureScreenshot', { format: 'png' })
  if (m.result?.data) writeFileSync(join(shots, `${name}.png`), Buffer.from(m.result.data, 'base64'))
}

// ---- the steps ------------------------------------------------------------------

const results = []
async function step(name, fn) {
  const start = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`✔ ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`)
  } catch (err) {
    results.push({ name, ok: false, error: err.message })
    console.log(`✖ ${name}: ${err.message}`)
    // Leave nothing half-open for the next step.
    await pressEscape().catch(() => undefined)
    if (await evaluate(`!!document.querySelector('.chat-stop')`).catch(() => false)) {
      await click('Stop', 'button.chat-stop').catch(() => undefined)
      await idle(60_000).catch(() => undefined)
    }
  }
  // With a time limit: after the app has closed, the screenshot request would never be answered.
  await Promise.race([shot(name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()).catch(() => undefined), sleep(5000)])
}

const takeoverSwitch = join(data, 'test-claude-out')

// Claude Code writes plans to the real ~/.claude/plans; this run's are the new ones about the test shop.
const testStart = Date.now()
const plansDir = join(homedir(), '.claude', 'plans')
function planFilesFromThisRun() {
  if (!existsSync(plansDir)) return []
  return readdirSync(plansDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(plansDir, f))
    .filter((f) => {
      try {
        return statSync(f).mtimeMs >= testStart - 1000 && /shop\.js/.test(readFileSync(f, 'utf-8'))
      } catch {
        return false
      }
    })
}

try {
  if (!page) throw new Error('The app window never appeared.')

  await step('the app opens with both accounts ready', async () => {
    await waitFor(`[...document.querySelectorAll('.app-nav-tabs button')].some((b) => b.textContent === 'Projects' && !b.disabled)`, 'Claude to be ready', 90_000)
  })

  await step('both usage meters show numbers', async () => {
    await waitFor(`[...document.querySelectorAll('.usage-meter')].length === 2 && [...document.querySelectorAll('.usage-meter')].every((m) => /%/.test(m.textContent))`, 'usage numbers', 60_000)
  })

  await step('the test project opens', async () => {
    await click('Projects')
    await click('e2e-game', 'button.project-row')
    await waitFor(`!!document.querySelector('textarea.chat-input')`, 'the chat')
  })

  // -- the live preview --

  let preview
  await step('the live preview shows the project page', async () => {
    await waitFor(`!!document.querySelector('webview')`, 'the preview to start', 60_000)
    for (let i = 0; i < 40 && !preview; i++) {
      preview = await attach((t) => t.type === 'webview').catch(() => null)
      if (!preview) await sleep(500)
    }
    if (!preview) throw new Error('no preview page')
    await waitFor(`document.title === 'E2E Shop'`, 'the page to load', 30_000, preview)
  })

  await step('Point picks an element in the preview', async () => {
    if (!preview) throw new Error('no preview page')
    await click('Point')
    await sleep(800)
    const box = await preview.evaluate(`(() => { const r = document.getElementById('title').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await preview.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    }
    await waitFor(`/E2E Shop/.test(document.querySelector('.picked-chip')?.innerText ?? '')`, 'the picked element chip', 10_000)
    await click('✕', '.picked-chip button')
  })

  await step('an error in the page shows the "Something broke" banner', async () => {
    if (!preview) throw new Error('no preview page')
    writeFileSync(join(project, 'index.html'), PAGE.replace('</body>', '<script>throw new Error("e2e boom")</script></body>'))
    await click('⟳')
    await waitFor(`/Something broke in your app/.test(document.body.innerText)`, 'the problem banner', 30_000)
    await click('Dismiss', '.problem-banner button')
    writeFileSync(join(project, 'index.html'), PAGE)
    await click('⟳')
  })

  // -- building, reviewing, undoing --

  await step('Claude edits a file itself and Codex double-checks it', async () => {
    await send('Add a function sellPrice(item) to shop.js that returns half of that item\'s price, rounded down, and export it alongside the prices. Make the edit yourself; do not hand it to Codex.')
    await waitFor(`!!document.querySelector('.review-card')`, 'the Codex review to start', 300_000)
    await idle()
    if (!/sellPrice/.test(readFileSync(join(project, 'shop.js'), 'utf-8'))) throw new Error('shop.js was not changed')
    const review = await evaluate(`[...document.querySelectorAll('.review-card')].map((c) => c.innerText).join(' | ')`)
    if (/couldn't review/i.test(review)) throw new Error(`review failed: ${review}`)
    if (!/double-checked|found \d+ issue/i.test(review)) throw new Error(`no review result: ${review}`)
  })

  await step('Undo puts the file back', async () => {
    await click('Undo', 'button.chat-undo')
    await waitFor(`/Undid changes/.test(document.querySelector('.chat-log').innerText)`, 'the "Undid changes" notice', 20_000)
    if (readFileSync(join(project, 'shop.js'), 'utf-8') !== originalShop) throw new Error('shop.js is not back to how it was')
  })

  await step('a checkpoint is saved and listed on the History screen', async () => {
    writeFileSync(join(project, 'notes.md'), '# Notes\n')
    await click('Checkpoint')
    await waitFor(`!!document.querySelector('.checkpoint-modal input')`, 'the checkpoint box', 5000)
    await fill('.checkpoint-modal input', 'E2E checkpoint')
    await click('Save', '.checkpoint-modal-actions button').catch(() => click('Checkpoint', '.checkpoint-modal-actions button'))
    await waitFor(`!document.querySelector('.checkpoint-modal')`, 'the box to close', 15_000)
    const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: project }).toString()
    if (!/E2E checkpoint/.test(log)) throw new Error(`not committed: ${log}`)
    await click('History')
    await waitFor(`/E2E checkpoint/.test(document.body.innerText)`, 'the checkpoint in History', 10_000)
    await click('Back', 'button').catch(() => click('←', 'button'))
    await waitFor(`!!document.querySelector('textarea.chat-input')`, 'the chat again', 10_000)
  })

  // -- plan mode --

  const planCards = () => evaluate(`[...document.querySelectorAll('.plan-card')].map((c) => ({ status: c.className, text: c.innerText }))`)

  await step('Plan mode proposes a plan and changes nothing', async () => {
    await click('Plan', '.chat-mode-switch button')
    await send('Add a function buyPrice(item) to shop.js that returns the item\'s price plus 10%, rounded up, and export it alongside the prices.')
    await waitFor(`!!document.querySelector('.plan-card-pending')`, 'a proposed plan', 300_000)
    await idle(120_000)
    if (readFileSync(join(project, 'shop.js'), 'utf-8') !== originalShop) throw new Error('shop.js changed before the plan was approved')
    const steps = await evaluate(`document.querySelectorAll('.plan-card-pending .plan-step').length`)
    console.log(`  (plan with ${steps} steps)`)
    if (steps < 1) throw new Error('the plan has no steps')
  })

  await step('"Change it" sends feedback and Claude revises the plan', async () => {
    await click('Change it', '.plan-card-pending button')
    await waitFor(`!!document.querySelector('.plan-change textarea')`, 'the feedback box', 5000)
    await fill('.plan-change textarea', 'Also add a one-line comment above the function saying what it does.')
    await click('Revise the plan', '.plan-change button')
    await waitFor(`document.querySelectorAll('.plan-card').length >= 2 && !!document.querySelector('.plan-card-pending')`, 'the revised plan', 300_000)
    await idle(120_000)
    const cards = await planCards()
    if (!/plan-card-revised/.test(cards[0].status)) throw new Error('the first plan is not marked as revised')
    if (readFileSync(join(project, 'shop.js'), 'utf-8') !== originalShop) throw new Error('shop.js changed before approval')
  })

  await step('"Approve and build" builds the plan and ticks its steps off', async () => {
    await click('Approve and build', '.plan-card-pending button')
    await waitFor(`!!document.querySelector('.chat-stop')`, 'building to start', 15_000)
    await idle(600_000)
    const shop = readFileSync(join(project, 'shop.js'), 'utf-8')
    if (!/buyPrice/.test(shop)) throw new Error('buyPrice was not added')
    const card = await evaluate(`(() => { const c = [...document.querySelectorAll('.plan-card-approved')].at(-1); return c ? { done: c.querySelectorAll('.plan-step-done').length, steps: c.querySelectorAll('.plan-step').length } : null })()`)
    if (!card) throw new Error('no approved plan card')
    console.log(`  (${card.done} of ${card.steps} steps ticked off)`)
    if (card.done < 1) throw new Error('no steps were ticked off while building')
  })

  await step('a cancelled plan changes nothing', async () => {
    const before = readFileSync(join(project, 'shop.js'), 'utf-8')
    await send('Rename the potion to elixir everywhere in shop.js.')
    await waitFor(`!!document.querySelector('.plan-card-pending')`, 'a proposed plan', 300_000)
    await idle(120_000)
    await click('Cancel', '.plan-card-pending button')
    await waitFor(`!document.querySelector('.plan-card-pending') && [...document.querySelectorAll('.plan-card-cancelled')].length > 0`, 'the plan to show as cancelled', 10_000)
    if (readFileSync(join(project, 'shop.js'), 'utf-8') !== before) throw new Error('shop.js changed')
    await click('Build', '.chat-mode-switch button')
    // Back to how the rest of the test expects the file.
    writeFileSync(join(project, 'shop.js'), originalShop)
  })

  await step('if Claude skips the progress tool, the plan still ticks off or finishes honestly', async () => {
    const noProgress = join(data, 'test-no-plan-progress')
    writeFileSync(noProgress, '')
    try {
      await click('Plan', '.chat-mode-switch button')
      await send('Add a function discount(item, percent) to shop.js that returns the price minus that percent, rounded down, and export it alongside the prices.')
      await waitFor(`!!document.querySelector('.plan-card-pending')`, 'a proposed plan', 300_000)
      await idle(120_000)
      await click('Approve and build', '.plan-card-pending button')
      await waitFor(`!!document.querySelector('.chat-stop')`, 'building to start', 15_000)
      await idle(600_000)
      if (!/discount/.test(readFileSync(join(project, 'shop.js'), 'utf-8'))) throw new Error('discount was not added')
      const card = await evaluate(`(() => { const c = [...document.querySelectorAll('.plan-card-approved')].at(-1); return c ? { done: c.querySelectorAll('.plan-step-done').length, steps: c.querySelectorAll('.plan-step').length, status: c.querySelector('.plan-card-status').innerText } : null })()`)
      if (!card) throw new Error('no approved plan card')
      console.log(`  (${card.done} of ${card.steps} ticked; status "${card.status}")`)
      if (!/finished|stopped/i.test(card.status)) throw new Error(`the card never says the build ended: ${card.status}`)
      if (card.done < card.steps && !/weren't reported/.test(card.status)) throw new Error('untracked steps are not admitted')
    } finally {
      rmSync(noProgress, { force: true })
      await click('Build', '.chat-mode-switch button').catch(() => undefined)
      writeFileSync(join(project, 'shop.js'), originalShop)
    }
  })

  await step('a big request in Build asks "Plan it first?"', async () => {
    const before = readFileSync(join(project, 'shop.js'), 'utf-8')
    await type('Please make these changes to shop.js:\n- add a shield costing 60 gold\n- add a bow costing 90 gold\n- add an arrow costing 2 gold\n- add a comment listing every item')
    await waitFor(`!!document.querySelector('.plan-suggestion')`, 'the "Plan it first?" card', 60_000)
    await idle(30_000)
    if (readFileSync(join(project, 'shop.js'), 'utf-8') !== before) throw new Error('shop.js changed before choosing')
    await click('Plan it', '.plan-suggestion button')
    await waitFor(`!!document.querySelector('.plan-card-pending')`, 'a proposed plan', 300_000)
    await idle(120_000)
    await click('Cancel', '.plan-card-pending button')
    await waitFor(`!document.querySelector('.plan-card-pending')`, 'the plan to be cancelled', 10_000)
    if (readFileSync(join(project, 'shop.js'), 'utf-8') !== before) throw new Error('shop.js changed')
  })

  await step('built and cancelled plans leave no old plan file behind', async () => {
    // Claude Code's plan files are in the real ~/.claude/plans (it has no test setting); count this run's.
    const left = planFilesFromThisRun()
    if (left.length) throw new Error(`still there: ${left.join(', ')}`)
  })

  // -- the Notes tab: to-do list and notes --

  const todos = () => evaluate(`window.vibe.todos.list(${JSON.stringify(PROJECT_ID)})`)

  await step('the Notes tab saves to-dos and notes, and warns about a secret key', async () => {
    await click('Notes', '.chat-header-actions button')
    await waitFor(`!!document.querySelector('.todo-add input')`, 'the Notes tab', 10_000)
    for (const text of ['Add a shield to shop.js costing 60 gold', 'Write a README']) {
      await fill('.todo-add input', text)
      await click('Add', '.todo-add button')
    }
    await waitFor(`document.querySelectorAll('.todo-list .todo-item').length === 2`, 'both to-dos', 10_000)
    await evaluate(`[...document.querySelectorAll('.todo-item')].find((r) => r.textContent.includes('README')).querySelector('input[type=checkbox]').click()`)
    await waitFor(`/Done \\(1\\)/.test(document.querySelector('.notes-pane').innerText)`, 'the done list', 10_000)
    await fill('textarea.notes-text', 'Test server: http://localhost:3000\nLogin: admin / admin')
    await sleep(1500)
    const saved = await evaluate(`window.vibe.notes.get(${JSON.stringify(PROJECT_ID)})`)
    if (!/localhost:3000/.test(saved.text)) throw new Error(`notes not saved: ${JSON.stringify(saved)}`)
    await fill('textarea.notes-text', 'Test server: http://localhost:3000\nAWS key AKIAABCDEFGHIJKLMNOP')
    await waitFor(`!!document.querySelector('.notes-secret-warning')`, 'the secret warning', 5000)
    await fill('textarea.notes-text', 'Test server: http://localhost:3000')
    await sleep(1500)
    const list = await todos()
    if (list.length !== 2 || !list.find((t) => /README/.test(t.text))?.done) throw new Error(`to-dos: ${JSON.stringify(list)}`)
  })

  await step('"Build this" sends a to-do to Claude and ticks it off when done', async () => {
    await evaluate(`[...document.querySelectorAll('.todo-item')].find((r) => r.textContent.includes('shield')).querySelector('.todo-build').click()`)
    await waitFor(`!!document.querySelector('.chat-stop')`, 'the request to start', 15_000)
    await idle(600_000)
    if (!/shield/i.test(readFileSync(join(project, 'shop.js'), 'utf-8'))) throw new Error('shop.js has no shield')
    await waitFor(
      `window.vibe.todos.list(${JSON.stringify(PROJECT_ID)}).then((l) => l.find((t) => /shield/.test(t.text))?.done === true)`,
      'the to-do to be ticked off',
      20_000
    )
    writeFileSync(join(project, 'shop.js'), originalShop)
  })

  await step('Claude reads the notes when asked, and adds a leftover to the to-do list', async () => {
    await send('Check my notes for this project and tell me the test server address. Also put "Add a sell button to the shop" on my to-do list for later. Change no files.')
    await idle(300_000)
    if (!/localhost:3000/.test(await lastReply())) throw new Error(`no address in the reply: ${(await lastReply()).slice(0, 200)}`)
    // The list on screen updates by itself (the agent writes from its own process).
    await waitFor(`[...document.querySelectorAll('.todo-item')].some((r) => /sell button/i.test(r.textContent) && /from Claude/.test(r.textContent))`, 'the new to-do on screen', 20_000)
  })

  await step('Codex adds to the to-do list too', async () => {
    writeFileSync(takeoverSwitch, '')
    try {
      await send('Put "Check the shop on a phone" on my to-do list for later, using your to-do tools. Change no files.')
      await idle(600_000)
    } finally {
      rmSync(takeoverSwitch, { force: true })
    }
    await waitFor(`[...document.querySelectorAll('.todo-item')].some((r) => /on a phone/i.test(r.textContent) && /from Codex/.test(r.textContent))`, "Codex's to-do on screen", 20_000)
    if (readFileSync(join(project, 'shop.js'), 'utf-8') !== originalShop) throw new Error('shop.js changed')
  })

  const todoOnScreen = (pattern, who) =>
    waitFor(
      `[...document.querySelectorAll('.todo-item')].some((r) => ${pattern}.test(r.textContent) && /from ${who}/.test(r.textContent))`,
      `the to-do from ${who} on screen`,
      20_000
    )

  await step('Ask mode adds to the to-do list and reads the notes, changing no files', async () => {
    await click('Ask', '.chat-mode-switch button')
    try {
      await send('Put "Try the shop on a tablet" on my to-do list, and tell me the test server address from my notes.')
      await idle(300_000)
      if (!/localhost:3000/.test(await lastReply())) throw new Error(`no address in the reply: ${(await lastReply()).slice(0, 200)}`)
      await todoOnScreen('/on a tablet/i', 'Claude')
    } finally {
      await click('Build', '.chat-mode-switch button')
    }
    if (readFileSync(join(project, 'shop.js'), 'utf-8') !== originalShop) throw new Error('shop.js changed')
  })

  await step('"add X to my to-do list" typed in Build takes the cheap path', async () => {
    await send('Add "Tidy up the shop prices" to my to-do list')
    await idle(300_000)
    const text = await chatText()
    // The label comes between the message and the reply (which repeats the item).
    if (!/Answered as a question/.test(text.slice(text.lastIndexOf('Add "Tidy up the shop prices"')))) throw new Error('it went to the full Build session')
    await todoOnScreen('/tidy up the shop prices/i', 'Claude')
  })

  await step('when Claude is out, Codex adds to the to-do list in Ask mode too', async () => {
    writeFileSync(takeoverSwitch, '')
    await click('Ask', '.chat-mode-switch button')
    try {
      await send('Put "Add sound effects to the shop" on my to-do list.')
      await idle(300_000)
    } finally {
      rmSync(takeoverSwitch, { force: true })
      await click('Build', '.chat-mode-switch button')
    }
    await todoOnScreen('/sound effects/i', 'Codex')
    if (readFileSync(join(project, 'shop.js'), 'utf-8') !== originalShop) throw new Error('shop.js changed')
    await click('Preview', '.chat-header-actions button')
  })

  // -- asking --

  await step('Ask mode answers without changing anything', async () => {
    await click('Ask', '.chat-mode-switch button')
    await send('What does the sword cost in shop.js?')
    await idle(180_000)
    const text = await chatText()
    if (!/Question/.test(text) || !/140/.test(await lastReply())) throw new Error('no answer with the price')
    await click('Build', '.chat-mode-switch button')
  })

  await step('a plain question typed in Build is answered the cheap way', async () => {
    await send('How many prices are listed in shop.js?')
    await idle(180_000)
    if (!/Answered as a question/.test(await chatText())) throw new Error('was not routed to Ask')
    await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Do it in Build instead'))`, 'the Build-instead button', 5000)
  })

  await step('an attached image reaches Claude', async () => {
    const { root: doc } = (await cdp('DOM.getDocument', { depth: -1 })).result
    const { nodeId } = (await cdp('DOM.querySelector', { nodeId: doc.nodeId, selector: 'input[type=file]' })).result
    await cdp('DOM.setFileInputFiles', { nodeId, files: [redImage] })
    await waitFor(`!!document.querySelector('.pending-images img')`, 'the image preview', 10_000)
    await send('What colour is the attached image? Answer with one word.')
    await idle(180_000)
    if (!/red/i.test(await lastReply())) throw new Error(`reply: ${await lastReply()}`)
  })

  // -- prompts and questions --

  await step('Claude can ask a question with options and gets the answer', async () => {
    await send('Before doing anything else, use your AskUserQuestion tool to ask me whether I prefer Red or Blue (exactly those two options). Then reply with only my choice.')
    await waitFor(`!!document.querySelector('.question-card')`, 'the question card', 120_000)
    await click('Blue', '.question-option')
    await click('', '.question-submit')
    await idle(120_000)
    if (!/blue/i.test(await lastReply())) throw new Error(`reply: ${await lastReply()}`)
  })

  await step('risky commands ask first, and Allow and Deny are respected', async () => {
    mkdirSync(join(project, 'a_tmp'))
    mkdirSync(join(project, 'b_tmp'))
    await send('Run these two shell commands now, both at once as two separate tool calls in the same message: rm -rf a_tmp  and  rm -rf b_tmp . Do not ask me in chat first; just run them.')
    await waitFor(`/Allow it\\?/.test(document.body.innerText)`, 'the first Allow/Deny prompt', 120_000)
    await click('Allow', '.confirmation-banner button')
    let prompts = 1
    for (let i = 0; i < 60; i++) {
      if (await evaluate(`/Allow it\\?/.test(document.body.innerText)`)) {
        prompts++
        await click('Deny', '.confirmation-banner button')
        break
      }
      if (!(await evaluate(`!!document.querySelector('.chat-stop')`))) break
      await sleep(1000)
    }
    await idle(120_000)
    console.log(`  (${prompts} prompt${prompts === 1 ? '' : 's'} shown)`)
    if (existsSync(join(project, 'a_tmp'))) throw new Error('the allowed command did not run')
    if (prompts === 2 && !existsSync(join(project, 'b_tmp'))) throw new Error('the denied command ran anyway')
  })

  await step('Go Nutz mode turns on (after confirming) and off', async () => {
    await click('Go Nutz', '.go-nutz-control button')
    await click('', '.go-nutz-confirm')
    await waitFor(`/Go Nutz mode is ON/.test(document.body.innerText)`, 'the Go Nutz banner', 10_000)
    await click('Go Nutz', '.go-nutz-control button')
    await waitFor(`!/Go Nutz mode is ON/.test(document.body.innerText)`, 'the banner to go', 10_000)
  })

  // -- secrets --

  const SECRET = 'zebra-quartz-77-plum'
  await step('a secret is saved and reaches Claude as an environment variable', async () => {
    await click('Secrets')
    await waitFor(`!!document.querySelector('.secret-add input')`, 'the secrets box', 5000)
    await fill('.secret-add input[placeholder^="NAME"]', 'E2E_SECRET')
    await fill('.secret-add input[placeholder="Value"]', SECRET)
    await click('Save', '.secret-add button')
    await waitFor(`/E2E_SECRET/.test(document.querySelector('.secret-list')?.innerText ?? '')`, 'the secret in the list', 10_000)
    await pressEscape()
    await send('Using a shell command, find out how many characters long the E2E_SECRET environment variable is (do not print the value). Reply with just the number.')
    await idle(180_000)
    if (!/\b20\b/.test(await lastReply())) throw new Error(`reply: ${await lastReply()}`)
  })

  await step('a secret written into a project file is caught', async () => {
    await send(`Create a file named notes.txt whose entire content is this text: ${SECRET}`)
    await idle(180_000)
    if (!existsSync(join(project, 'notes.txt'))) throw new Error('Claude did not create the file')
    await waitFor(`/secret key was written into your project files/.test(document.body.innerText)`, 'the leak banner', 15_000)
    await click('Dismiss', '.problem-banner button')
  })

  // -- Claude out of plan: the takeover screens (simulated with a test switch) --

  await step('when Claude is out, Codex takes the request (banner and result)', async () => {
    writeFileSync(takeoverSwitch, '')
    await send('Create a file takeover.txt containing the word done.')
    await waitFor(`/Codex is handling this directly/.test(document.querySelector('.chat-log').innerText)`, 'the takeover banner', 30_000)
    await idle(600_000)
    if (!existsSync(join(project, 'takeover.txt'))) throw new Error('Codex did not create the file')
  })

  await step('when Claude is out, Codex makes the plan and builds it once approved', async () => {
    writeFileSync(takeoverSwitch, '')
    const before = readFileSync(join(project, 'shop.js'), 'utf-8')
    try {
      await click('Plan', '.chat-mode-switch button')
      await send('Add a function taxPrice(item) to shop.js that returns the price plus 5%, rounded up, and export it alongside the prices.')
      await waitFor(`/by Codex/.test(document.querySelector('.plan-card-pending .plan-card-header')?.innerText ?? '')`, 'a plan by Codex', 600_000)
      await idle(60_000)
      if (readFileSync(join(project, 'shop.js'), 'utf-8') !== before) throw new Error('shop.js changed while planning')
      await click('Approve and build', '.plan-card-pending button')
      await waitFor(`!!document.querySelector('.chat-stop')`, 'building to start', 15_000)
      await idle(600_000)
      if (!/taxPrice/.test(readFileSync(join(project, 'shop.js'), 'utf-8'))) throw new Error('taxPrice was not added')
      const card = await evaluate(`(() => { const c = [...document.querySelectorAll('.plan-card-approved')].at(-1); return c ? { done: c.querySelectorAll('.plan-step-done').length, steps: c.querySelectorAll('.plan-step').length, status: c.querySelector('.plan-card-status').innerText } : null })()`)
      if (!card) throw new Error('no approved plan card')
      console.log(`  (${card.done} of ${card.steps} ticked; status "${card.status}")`)
      if (!/finished|stopped/i.test(card.status)) throw new Error(`the card never says the build ended: ${card.status}`)
    } finally {
      await click('Build', '.chat-mode-switch button').catch(() => undefined)
    }
  })

  await step('with "ask me first", Codex only runs after "Let Codex do it"', async () => {
    await evaluate(`window.vibe.settings.update({ limitTakeover: 'ask' })`)
    try {
      await type('Create a file second.txt containing ok.')
      await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Let Codex do it'))`, 'the offer button', 30_000)
      if (existsSync(join(project, 'second.txt'))) throw new Error('ran before being asked')
      await click('Let Codex do it')
      await waitFor(`!!document.querySelector('.chat-stop')`, 'Codex to start', 15_000)
      await idle(600_000)
      if (!existsSync(join(project, 'second.txt'))) throw new Error('Codex did not create the file')
    } finally {
      // Even when it fails, so the steps after it use Claude again.
      await evaluate(`window.vibe.settings.update({ limitTakeover: 'auto' })`).catch(() => undefined)
      rmSync(takeoverSwitch, { force: true })
    }
  })

  // -- shrinking and stopping --

  await step('compacting the conversation shows a notice and keeps working', async () => {
    const result = await evaluate(`window.vibe.chat.compactNow(${JSON.stringify(PROJECT_ID)}, ${JSON.stringify(project)})`)
    if (!result?.ok) throw new Error(result?.message ?? 'compaction failed')
    await waitFor(`/Compacted the conversation/.test(document.querySelector('.chat-log').innerText)`, 'the compaction notice', 20_000)
    await send('In one word: which file holds the prices?')
    await idle(180_000)
    if (!/shop/i.test(await lastReply())) throw new Error('no sensible reply after compacting')
  })

  await step('Stop ends a running request', async () => {
    await send('Write a 400-line file big.js with many small, fully commented utility functions. Do it yourself.')
    await sleep(6000)
    await click('Stop', 'button.chat-stop')
    await idle(60_000)
    if (!/Stopped/.test((await chatText()).slice(-400))) throw new Error('no Stopped notice')
  })

  // -- other screens --

  await step('the Chat tab talks to Claude and then Codex, keeping the conversation', async () => {
    await click('Chat', '.app-nav-tabs button')
    await click('Claude', '.talk-compose .chat-mode-switch button')
    await type('Remember the word BANANA and reply with just OK.')
    await waitFor(`/OK/.test(document.querySelector('.talk-log').innerText)`, "Claude's reply", 120_000)
    await click('Codex', '.talk-compose .chat-mode-switch button')
    await type('What word did I ask you to remember? One word.')
    await waitFor(`/Codex[\\s\\S]*BANANA/i.test(document.querySelector('.talk-log').innerText)`, "Codex's reply", 180_000)
  })

  await step('settings changes are saved', async () => {
    await click('Settings', '.app-nav-tabs button')
    await click('Answer plain questions the cheap way', 'label')
    await sleep(800)
    const saved = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf-8'))
    if (saved.autoAsk !== false) throw new Error(`autoAsk is ${saved.autoAsk}`)
  })

  await step("the Codex model and effort menus list Codex's own choices and save", async () => {
    const selectFor = (label) =>
      `[...document.querySelectorAll('.settings-field')].find((f) => f.querySelector('span')?.textContent.startsWith(${JSON.stringify(label)}))?.querySelector('select')`
    await waitFor(`(${selectFor('Codex (')})?.options.length > 1 && !(${selectFor('Codex (')}).disabled`, 'the Codex model list', 30_000)
    const models = await evaluate(`[...(${selectFor('Codex (')}).options].map((o) => o.value).filter(Boolean)`)
    console.log(`  (Codex models: ${models.join(', ')})`)
    const choose = (label, value) =>
      evaluate(`(() => { const s = ${selectFor(label)}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await choose('Codex (', models[0])
    await sleep(500)
    const efforts = await evaluate(`[...(${selectFor('Codex thinking')}).options].map((o) => o.value).filter(Boolean)`)
    if (!efforts.length) throw new Error('no effort choices')
    await choose('Codex thinking', efforts[0])
    await sleep(800)
    const saved = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf-8'))
    if (saved.codexModel !== models[0] || saved.codexEffort !== efforts[0]) {
      throw new Error(`saved ${saved.codexModel} / ${saved.codexEffort}`)
    }
    // Back to how the test started for anything after this.
    await choose('Codex (', E2E_CODEX_MODEL)
    await choose('Codex thinking', '')
    await sleep(500)
  })

  await step('the Extensions screen lists tools to install', async () => {
    await click('Extensions', '.app-nav-tabs button')
    await waitFor(`/Up-to-date docs/.test(document.body.innerText)`, 'the catalog', 15_000)
  })

  // -- extensions really work (not just install) --

  const transcriptText = () =>
    readdirSync(join(data, 'transcripts'))
      .map((f) => readFileSync(join(data, 'transcripts', f), 'utf-8'))
      .join('\n')

  await step('the listed extensions install and pass their check (Playwright opens a page)', async () => {
    await click('Extensions', '.app-nav-tabs button')
    for (const name of ['Browser testing (Playwright)', 'Up-to-date docs (Context7)', 'Step-by-step thinking']) {
      const rowWith = `[...document.querySelectorAll('.extension-row')].find((r) => r.textContent.includes(${JSON.stringify(name)}) && !!r.querySelector('.extension-status'))`
      const installed = await evaluate(`(() => {
        const row = [...document.querySelectorAll('.extension-row')].find((r) => r.textContent.includes(${JSON.stringify(name)}) && [...r.querySelectorAll('button')].some((b) => b.textContent === 'Install'))
        if (!row) return false
        ;[...row.querySelectorAll('button')].find((b) => b.textContent === 'Install').click()
        return true
      })()`)
      if (!installed) throw new Error(`no Install button for ${name}`)
      await waitFor(`/✓ Works|✗ Not working/.test((${rowWith})?.textContent ?? '')`, `${name} to be checked`, 180_000)
      const status = await evaluate(`(${rowWith}).querySelector('.extension-status').textContent`)
      console.log(`  (${name}: ${status.slice(0, 160)})`)
      if (!/✓ Works/.test(status)) throw new Error(`${name}: ${status}`)
    }
  })

  let previewUrl = ''
  await step('Claude uses the Playwright extension to open the preview', async () => {
    await click('Projects', '.app-nav-tabs button')
    await click('e2e-game', 'button.project-row')
    await waitFor(`!!document.querySelector('textarea.chat-input')`, 'the chat')
    await waitFor(`window.vibe.preview.state(${JSON.stringify(PROJECT_ID)}).then((s) => s.status === 'running')`, 'the preview', 60_000)
    previewUrl = (await evaluate(`window.vibe.preview.state(${JSON.stringify(PROJECT_ID)})`)).url
    await send(`Use the Playwright browser tools to open ${previewUrl} and tell me the page's exact title. Use the browser, not the files, and don't change anything.`)
    await idle(300_000)
    if (!/E2E Shop/.test(await lastReply())) throw new Error(`no title in the reply: ${(await lastReply()).slice(0, 200)}`)
    if (!/mcp__ext_browser_testing_playwrig__browser_navigate/.test(transcriptText())) throw new Error('Claude did not use the Playwright tools')
    if (existsSync(join(project, '.playwright-mcp'))) throw new Error('Playwright left files in the project')
  })

  await step('Codex uses the Playwright extension too', async () => {
    if (!previewUrl) throw new Error('no preview address')
    // Straight to Codex (as when Claude is out), so Claude can't answer it itself.
    writeFileSync(takeoverSwitch, '')
    try {
      await send(`Use the Playwright browser tools to open ${previewUrl} and tell me the page's exact heading text. Use the browser, not the files, and change nothing.`)
      await idle(600_000)
    } finally {
      rmSync(takeoverSwitch, { force: true })
    }
    if (!/ext_browser_testing_playwrig: browser_navigate/.test(transcriptText())) throw new Error('Codex did not use the Playwright tools')
    const text = await chatText()
    const after = text.slice(text.lastIndexOf('exact heading text'))
    if (!/E2E Shop/.test(after)) throw new Error(`no heading reported: ${after.slice(0, 300)}`)
    if (existsSync(join(project, '.playwright-mcp'))) throw new Error('Playwright left files in the project')
    for (const ext of (await evaluate('window.vibe.extensions.list()')).installed) {
      await evaluate(`window.vibe.extensions.remove(${JSON.stringify(ext.id)})`)
    }
  })

  await step('the Memory screen shows the project brief section', async () => {
    await click('Memory', '.app-nav-tabs button')
    await waitFor(`/Project brief/.test(document.body.innerText)`, 'the brief section', 15_000)
  })

  await step('nothing was saved to memory while automatic saving was off', async () => {
    const facts = await evaluate(`window.vibe.memory.list(${JSON.stringify(PROJECT_ID)}, 'project', false)`)
    const auto = (facts ?? []).filter((f) => f.source === 'scribe')
    if (auto.length) throw new Error(`saved anyway: ${auto.map((f) => f.text).join(' | ')}`)
  })

  await step('a project can be removed from the list (keeping its data)', async () => {
    await click('Projects', '.app-nav-tabs button')
    await click('', 'button.project-remove')
    await click('Remove from list', '.remove-choices button')
    await waitFor(`!/e2e-game/.test(document.body.innerText)`, 'the project to leave the list', 10_000)
  })

  // Last, since it closes the app.
  await step('closing VibeApp in the middle of a Codex job leaves nothing running', async () => {
    if (process.platform !== 'win32') return
    // Every process the app started, and theirs (with start times, so a reused process id isn't mistaken for one).
    const tree = () =>
      JSON.parse(
        execFileSync('powershell', [
          '-NoProfile',
          '-Command',
          `$all = Get-CimInstance Win32_Process; $ids = @(${app.pid}); $out = @(); do { $next = @($all | Where-Object { $ids -contains $_.ParentProcessId -and $out.ProcessId -notcontains $_.ProcessId }); $out += $next; $ids = @($next.ProcessId) } while ($next.Count); ConvertTo-Json -Compress @($out | ForEach-Object { @{ id = $_.ProcessId; name = $_.Name; started = $_.CreationDate.ToString('o') } })`
        ]).toString() || '[]'
      )
    // The app is gone by then, so each process is looked up directly.
    const alive = (procs) => {
      const live = JSON.parse(
        execFileSync('powershell', [
          '-NoProfile',
          '-Command',
          `ConvertTo-Json -Compress @(Get-CimInstance Win32_Process | ForEach-Object { @{ id = $_.ProcessId; started = $_.CreationDate.ToString('o') } })`
        ]).toString()
      )
      return procs.filter((p) => live.some((l) => l.id === p.id && l.started === p.started))
    }
    await click('Chat', '.app-nav-tabs button')
    await click('Codex', '.talk-compose .chat-mode-switch button')
    await type('Run the command "ping -n 120 127.0.0.1" and tell me its last line.')
    let before = []
    for (let i = 0; i < 60 && !before.some((p) => /^codex/i.test(p.name)); i++) {
      await sleep(1000)
      before = tree()
    }
    if (!before.some((p) => /^codex/i.test(p.name))) throw new Error('Codex never started')
    await sleep(4000) // let it get going (its own helpers, the command)
    before = tree()
    console.log(`  (closing with ${before.length} processes running: ${[...new Set(before.map((p) => p.name))].join(', ')})`)
    const exited = new Promise((resolve) => app.once('exit', resolve))
    await Promise.race([cdp('Browser.close'), sleep(3000)]).catch(() => undefined)
    if ((await Promise.race([exited.then(() => true), sleep(20_000).then(() => false)])) !== true) throw new Error('VibeApp did not close')
    await sleep(3000)
    const left = alive(before)
    if (left.length) throw new Error(`still running after closing: ${left.map((p) => `${p.name} (${p.id})`).join(', ')}`)
  })

  const errors = [...page.errors, ...(preview?.errors ?? [])].filter((e) => !/e2e boom/.test(e))
  if (errors.length) {
    results.push({ name: 'no errors in the app', ok: false, error: errors.slice(0, 5).join(' | ') })
    console.log(`✖ errors in the app: ${errors.slice(0, 5).join(' | ')}`)
  }
} catch (err) {
  console.log(`✖ ${err.message}`)
  results.push({ name: 'setup', ok: false, error: err.message })
} finally {
  // Leave nothing in the user's real Claude folder.
  for (const f of planFilesFromThisRun()) rmSync(f, { force: true })
  try {
    await Promise.race([cdp('Browser.close'), sleep(2000)])
  } catch {
    // already gone
  }
  app.kill()
  await sleep(1500)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} steps passed${packaged ? ' (packaged app)' : ''}. Screenshots: ${shots}`)
  writeFileSync(join(shots, 'app-log.txt'), appLog)
  for (const dir of [data, project]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // a process may still hold it; it's in the temp folder either way
    }
  }
  process.exit(failed.length ? 1 : 0)
}
