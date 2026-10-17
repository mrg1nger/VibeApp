// End-to-end test of the real app: builds it, launches Electron with its own
// data folder and a fresh test project, and drives the screens through the
// Chrome DevTools protocol (clicks and typing, as a person would).
//
//   npm run e2e
//
// Needs Claude Code and Codex installed and logged in. Takes several minutes
// and uses a little of both plans (Claude runs on Haiku). Screenshots of each
// step are saved to out/e2e/.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = join(root, 'out', 'e2e')
const PORT = 9400 + Math.floor(Math.random() * 400)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- setup ----------------------------------------------------------------------

if (!process.argv.includes('--no-build')) {
  console.log('Building the app...')
  const built = spawnSync('npx', ['electron-vite', 'build'], { cwd: root, stdio: 'inherit', shell: true })
  if (built.status !== 0) process.exit(built.status ?? 1)
}
rmSync(shots, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })

const project = mkdtempSync(join(tmpdir(), 'vibeapp-e2e-project-'))
writeFileSync(join(project, 'shop.js'), '// Shop prices: potion costs 25 gold, sword costs 140 gold.\nmodule.exports = { potion: 25, sword: 140 }\n')
writeFileSync(join(project, 'battle.js'), '// Battle damage formula: damage = attack * 2 - defence\nmodule.exports = (a, d) => a * 2 - d\n')
for (const args of [['init'], ['add', '-A'], ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'commit', '-m', 'start']]) {
  execFileSync('git', args, { cwd: project, stdio: 'ignore' })
}
const originalShop = readFileSync(join(project, 'shop.js'), 'utf-8')

const data = mkdtempSync(join(tmpdir(), 'vibeapp-e2e-data-'))
const PROJECT_ID = 'e2e-project'
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
    codeMap: false
  })
)

const electron = createRequire(import.meta.url)('electron')
// Editors such as VS Code set this for the processes they start, and it would
// run Electron as plain Node instead of opening the app.
const env = { ...process.env, VIBEAPP_USER_DATA: data, ELECTRON_ENABLE_LOGGING: '1' }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
app.stderr.on('data', (d) => (appLog += d))

// ---- the DevTools connection -----------------------------------------------------

let ws
let nextId = 0
const pending = new Map()
const pageErrors = []

async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = targets.find((t) => t.type === 'page' && /index\.html|localhost:5173/.test(t.url))
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
        ws.onmessage = (raw) => {
          const m = JSON.parse(raw.data)
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m)
            pending.delete(m.id)
          } else if (m.method === 'Runtime.exceptionThrown') {
            pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
          }
        }
        await cdp('Runtime.enable')
        await cdp('Page.enable')
        return
      }
    } catch {
      // not up yet
    }
    await sleep(500)
  }
  throw new Error('The app window never appeared.')
}

function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const m = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return m.result?.result?.value
}

async function waitFor(expression, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      if (await evaluate(expression)) return
    } catch {
      // page mid-render
    }
    await sleep(400)
  }
  throw new Error(`Timed out waiting for: ${what}`)
}

/** Clicks the first visible button (or other element) whose text contains `text`. */
async function click(text, selector = 'button') {
  const ok = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => e.offsetParent !== null && !e.disabled && e.textContent.includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)
  if (!ok) throw new Error(`No clickable "${text}"`)
  await sleep(300)
}

/** Types into the chat box and presses Enter, like a person. */
async function send(text) {
  await waitFor(`!!document.querySelector('textarea.chat-input') && !document.querySelector('textarea.chat-input').disabled`, 'the message box')
  await evaluate(`document.querySelector('textarea.chat-input').focus()`)
  await cdp('Input.insertText', { text })
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitFor(`!!document.querySelector('.chat-stop')`, 'the request to start', 15_000)
}

/** Waits for the current request (including any Codex review) to finish. */
function idle(timeoutMs = 600_000) {
  return waitFor(`!document.querySelector('.chat-stop') && !document.querySelector('.chat-item-thinking')`, 'the request to finish', timeoutMs)
}

const chatText = () => evaluate(`document.querySelector('.chat-log')?.innerText ?? ''`)

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
    results.push({ name, ok: true, ms: Date.now() - start })
    console.log(`✔ ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`)
  } catch (err) {
    results.push({ name, ok: false, error: err.message })
    console.log(`✖ ${name}: ${err.message}`)
  }
  await shot(name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()).catch(() => undefined)
}

try {
  await connect()

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

  await step('Claude edits a file itself and Codex double-checks it', async () => {
    await send('Add a function sellPrice(item) to shop.js that returns half of that item\'s price, rounded down, and export it alongside the prices. Make the edit yourself; do not hand it to Codex.')
    await waitFor(`!!document.querySelector('.review-card')`, 'the Codex review to start', 300_000)
    await idle()
    const shop = readFileSync(join(project, 'shop.js'), 'utf-8')
    if (!/sellPrice/.test(shop)) throw new Error('shop.js was not changed')
    const review = await evaluate(`[...document.querySelectorAll('.review-card')].map((c) => c.innerText).join(' | ')`)
    if (/couldn't review/i.test(review)) throw new Error(`review failed: ${review}`)
    if (!/double-checked|found \d+ issue/i.test(review)) throw new Error(`no review result: ${review}`)
  })

  await step('Undo puts the file back', async () => {
    await click('Undo', 'button.chat-undo')
    await waitFor(`/Undid changes/.test(document.querySelector('.chat-log').innerText)`, 'the "Undid changes" notice', 20_000)
    if (readFileSync(join(project, 'shop.js'), 'utf-8') !== originalShop) throw new Error('shop.js is not back to how it was')
  })

  await step('Ask mode answers without changing anything', async () => {
    await click('Ask', '.chat-mode-switch button')
    await send('What does the sword cost in shop.js?')
    await idle(180_000)
    const text = await chatText()
    if (!/Question/.test(text) || !/140/.test(text.slice(-400))) throw new Error('no answer with the price')
    await click('Build', '.chat-mode-switch button')
  })

  await step('a plain question typed in Build is answered the cheap way', async () => {
    await send('How many prices are listed in shop.js?')
    await idle(180_000)
    const text = await chatText()
    if (!/Answered as a question/.test(text)) throw new Error('was not routed to Ask')
    await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Do it in Build instead'))`, 'the Build-instead button', 5000)
  })

  await step('compacting the conversation shows a notice and keeps working', async () => {
    const result = await evaluate(`window.vibe.chat.compactNow(${JSON.stringify(PROJECT_ID)}, ${JSON.stringify(project)})`)
    if (!result?.ok) throw new Error(result?.message ?? 'compaction failed')
    await waitFor(`/Compacted the conversation/.test(document.querySelector('.chat-log').innerText)`, 'the compaction notice', 20_000)
    await send('In one word: which file holds the prices?')
    await idle(180_000)
    if (!/shop/i.test((await chatText()).slice(-300))) throw new Error('no sensible reply after compacting')
  })

  await step('Stop ends a running request', async () => {
    await send('Write a 400-line file big.js with many small, fully commented utility functions. Do it yourself.')
    await sleep(6000)
    await click('Stop', 'button.chat-stop')
    await idle(60_000)
    if (!/Stopped/.test((await chatText()).slice(-400))) throw new Error('no Stopped notice')
  })

  await step('the Chat tab talks to Claude and then Codex, keeping the conversation', async () => {
    await click('Chat', '.app-nav-tabs button')
    await click('Claude', '.talk-compose .chat-mode-switch button')
    await send('Remember the word BANANA and reply with just OK.').catch(async () => {
      // The Chat tab has no Stop button showing while it waits briefly; fall back to plain waiting.
    })
    await waitFor(`/OK/.test(document.querySelector('.talk-log').innerText)`, "Claude's reply", 120_000)
    await click('Codex', '.talk-compose .chat-mode-switch button')
    await waitFor(`!document.querySelector('textarea.chat-input').disabled`, 'the message box')
    await evaluate(`document.querySelector('textarea.chat-input').focus()`)
    await cdp('Input.insertText', { text: 'What word did I ask you to remember? One word.' })
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await waitFor(`/Codex[\\s\\S]*BANANA/i.test(document.querySelector('.talk-log').innerText)`, "Codex's reply", 180_000)
  })

  await step('settings changes are saved', async () => {
    await click('Settings', '.app-nav-tabs button')
    await click('Answer plain questions the cheap way', 'label')
    await sleep(800)
    const saved = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf-8'))
    if (saved.autoAsk !== false) throw new Error(`autoAsk is ${saved.autoAsk}`)
  })

  await step('the Extensions screen lists tools to install', async () => {
    await click('Extensions', '.app-nav-tabs button')
    await waitFor(`/Up-to-date docs/.test(document.body.innerText)`, 'the catalog', 15_000)
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

  if (pageErrors.length) {
    results.push({ name: 'no errors in the page', ok: false, error: pageErrors.slice(0, 5).join(' | ') })
    console.log(`✖ errors in the page: ${pageErrors.slice(0, 5).join(' | ')}`)
  }
} catch (err) {
  console.log(`✖ ${err.message}`)
  results.push({ name: 'setup', ok: false, error: err.message })
} finally {
  try {
    await cdp('Browser.close')
  } catch {
    // already gone
  }
  app.kill()
  await sleep(1500)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} steps passed. Screenshots: ${shots}`)
  if (failed.length) {
    writeFileSync(join(shots, 'app-log.txt'), appLog)
    console.log(`App log saved to ${join(shots, 'app-log.txt')}`)
  }
  for (const dir of [data, project]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // a process may still hold it; it's in the temp folder either way
    }
  }
  process.exit(failed.length ? 1 : 0)
}
