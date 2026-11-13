import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runScribe, type TurnRecord } from '../../src/main/memory/scribe'
import { memoryDb } from '../../src/main/memory/paths'
import { deleteFact, GLOBAL_SCOPE, linkFactFiles, listFacts, noteFileChanges, rememberFact, usageSummary } from '../../src/main/memory/store'
import { tidyMemory } from '../../src/main/memory/tidy'
import { recordProjectOpened } from '../../src/main/projects/store'
import { updateSettings } from '../../src/main/settings/store'
import { weight } from '../../src/main/usage/report'
import type { MemoryCategory } from '@shared/types'
import { makeProject, projectId } from '../support/fixtures'
import { listClineModels, stopHostedCline } from '../../src/main/cli/clineAcp'
import { forgetLmStudioStatus } from '../../src/main/cli/lmStudio'

// The background-job evaluation: the same memory-saving cases on Haiku and on
// Cline (each model named), scored on getting them right, with time and
// tokens. Saving memory is the background job that runs most and matters
// most (a wrong fact misleads every later request).
//
//   npm run eval -- helpers
//   VIBEAPP_EVAL_HELPERS="haiku,cline-pass/glm-5.3-flash" npm run eval -- helpers
//   VIBEAPP_EVAL_HELPERS="lmstudio" npm run eval -- helpers         (the model loaded in LM Studio)
//   VIBEAPP_EVAL_HELPERS="lmstudio:qwen/qwen3.6-35b-a3b" npm run eval -- helpers

// 2026-11-10 (0.5.5, six cases): all 10 models ClinePass runs 6/6; kimi-k3.1-pro and minimax-m3.1-flash
// 18/18 over three runs. qwen3.7-plus/max, minimax-m3 and mimo-v2.6-flash/pro are listed but refused.
// Scores before 0.5.5 are not comparable: a global rule saved by one model was shown to the next as known.
// 2026-11-11 (0.7.0, eight cases with the two about memory's age): kimi-k3.1-pro and minimax-m3.1-flash 24/24
// over three runs, haiku 8/8. Before the check was told when a file is shown only in part, both ClinePass
// models retired a fact whose proof lay further down the file.
// "all": every ClinePass model offered now (VIBEAPP_EVAL_HELPERS=all npm run eval -- helpers).
const WANTED = process.env.VIBEAPP_EVAL_HELPERS ?? 'haiku,cline-pass/minimax-m3.1-flash,cline-pass/deepseek-v4.1-flash,cline-pass/qwen3.8-max'
const BACKENDS = WANTED.split(',')
  .map((b) => b.trim())
  .filter(Boolean)
after(() => stopHostedCline())

interface Case {
  name: string
  turn: TurnRecord
  /** Facts known beforehand (this project). */
  known?: string[]
  /** Returns what's wrong, or null. */
  judge: (facts: { text: string; category: string }[], global: { text: string; category: string }[], known: { text: string }[]) => string | null
}

const reply = (text: string): Pick<TurnRecord, 'replies' | 'actions' | 'stopped' | 'hadError'> => ({ replies: [text], actions: [], stopped: false, hadError: false })

const CASES: Case[] = [
  {
    name: 'setup and a project rule',
    turn: { request: 'The game runs with `npm run dev` on port 5173, and please always use tabs not spaces in this project.', ...reply('Got it: started the dev server and switched the formatter to tabs.') },
    judge: (facts, global) => {
      if (!facts.some((f) => /npm run dev/.test(f.text))) return 'missed how to run it'
      if (!facts.some((f) => /tab/i.test(f.text) && f.category === 'preference')) return 'missed the tabs rule'
      if (global.some((f) => /tab/i.test(f.text))) return 'made a project rule global'
      return null
    }
  },
  {
    name: 'one-off instruction is not a preference',
    turn: { request: 'Make the start button blue. Keep it tiny, no other changes.', ...reply('Done: the start button is blue now.') },
    judge: (facts) => (facts.some((f) => f.category === 'preference' || /tiny|blue/i.test(f.text)) ? `saved a one-off: ${facts.map((f) => f.text).join(' | ')}` : null)
  },
  {
    name: 'a rule for every project is global',
    turn: { request: 'From now on, in every project, write commit messages in British English.', ...reply("Understood, I'll use British English for commit messages everywhere.") },
    judge: (_facts, global) => (global.some((f) => /british/i.test(f.text)) ? null : 'not saved as a global preference')
  },
  {
    name: 'a rule for all the work, said less plainly, is global',
    turn: { request: "Whatever I'm working on, I want dates written like 10 November 2026, never 11/10/2026. Please fix the footer here to match.", ...reply('Done: the footer date now reads 10 November 2026.') },
    judge: (_facts, global) => (global.some((f) => /date/i.test(f.text)) ? null : 'not saved as a global preference')
  },
  {
    name: 'a key is never saved',
    turn: { request: 'The deploy uses the API key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefGHIJ, stored as DEPLOY_KEY in Secrets.', ...reply('Thanks. The deploy reads DEPLOY_KEY from the project secrets.') },
    judge: (facts, global) => ([...facts, ...global].some((f) => /sk-ant-|AbCdEfGh/.test(f.text)) ? 'saved the key' : null)
  },
  {
    name: 'an outdated fact is corrected, not contradicted',
    known: ['Tests run with npm test (node --test).'],
    turn: { request: 'We switched the tests to vitest: they now run with npx vitest run.', ...reply('Switched: tests now run with npx vitest run, and the old node --test files were converted.') },
    judge: (facts, _global, known) => {
      if (!facts.some((f) => /vitest/.test(f.text))) return 'missed the new test command'
      if (known.some((k) => facts.some((f) => f.text === k.text))) return 'kept the old fact alongside the new one'
      return null
    }
  }
]

/**
 * Memory that knows when it's old (0.7.0): the note-taker names the files a fact is about, and
 * the tidy-up checks facts whose files changed a lot or are gone. Each returns what's wrong, or null.
 */
const AGE_CASES: { name: string; run: () => Promise<string | null> }[] = [
  {
    name: 'a saved fact is linked to the file it is about, not every file the request changed',
    run: async () => {
      const dir = makeProject({ 'src/save.js': "export const SAVE_KEY = 'save-v2'\n", 'src/hud.js': "export const coinColour = 'gold'\n" })
      const pid = projectId('helpers_links')
      await runScribe(pid, {
        request: 'Remember this: progress is now saved under the key save-v2 (it was save-v1). Also make the coin counter gold.',
        replies: ['Done: SAVE_KEY in src/save.js is now save-v2, and the HUD coin counter is gold.'],
        actions: ['Edited src/save.js', 'Edited src/hud.js'],
        stopped: false,
        hadError: false,
        files: ['src/save.js', 'src/hud.js'],
        projectPath: dir
      })
      const facts = listFacts(memoryDb(), pid)
      const save = facts.find((f) => /save-v2/.test(f.text))
      if (!save) return `didn't save the save key: ${facts.map((f) => f.text).join(' | ') || '(nothing)'}`
      if (!save.files?.includes('src/save.js')) return `the save-key fact isn't linked to src/save.js (linked: ${save.files?.join(', ') || 'nothing'})`
      if (save.files.includes('src/hud.js')) return 'the save-key fact is linked to src/hud.js too'
      return null
    }
  },
  {
    name: 'the tidy-up retires facts its changed files contradict and keeps the others',
    run: async () => {
      const dir = makeProject({
        'src/sprites.js': '// Every enemy, the player and the coins are drawn here from one sprite sheet.\nexport function drawSprite(ctx, sheet, frame, x, y) {}\n',
        'src/score.js': '// Points\nexport const COIN_POINTS = 10\nexport const ENEMY_POINTS = 50\nexport function addScore(state, n) { state.score += n }\n',
        'src/input.js': "// Controls\nexport const keys = { jump: 'ArrowUp', left: 'ArrowLeft', right: 'ArrowRight' }\n",
        // Long: the font rule is past what the check is shown, so the file doesn't show either way.
        'src/hud.css': `.hud { position: absolute; top: 8px; right: 8px; }\n.coins { color: gold; }\n${Array.from({ length: 60 }, (_, i) => `.hud-row-${i} { margin-top: ${i}px; }`).join('\n')}\n.hud, .coins { font-family: 'Press Start 2P', monospace; }\n`
      })
      const scope = recordProjectOpened(dir).id
      const db = memoryDb()
      const fact = (text: string, category: MemoryCategory = 'decision') => rememberFact(db, scope, text, 'user', { category }).fact
      fact('The game is a 2D platformer for the browser.', 'about')
      fact('Levels are stored as JSON files in levels/.')
      const gone = fact('Enemies are drawn one by one in src/enemies.js.')
      const coins = fact('A coin is worth 10 points (src/score.js).')
      const jump = fact('Jumping uses the space bar (src/input.js).')
      const font = fact('The HUD uses the Press Start 2P font (src/hud.css).')
      linkFactFiles(db, gone.id, [{ path: 'src/enemies.js', lines: 60 }])
      for (const [f, path] of [[coins, 'src/score.js'], [jump, 'src/input.js'], [font, 'src/hud.css']] as const) linkFactFiles(db, f.id, [{ path, lines: 20 }])
      noteFileChanges(db, scope, ['src/score.js', 'src/input.js', 'src/hud.css'].map((path) => ({ path, added: 30, removed: 30 })), ['src/enemies.js'])
      await tidyMemory(scope)
      const left = new Set(listFacts(db, scope).map((f) => f.id))
      const wrong: string[] = []
      if (left.has(gone.id)) wrong.push('kept the fact about the deleted src/enemies.js')
      if (left.has(jump.id)) wrong.push('kept "jump is space" though input.js says ArrowUp')
      if (!left.has(coins.id)) wrong.push('retired "a coin is 10 points", which score.js still says')
      if (!left.has(font.id)) wrong.push("retired the HUD font fact, which the file doesn't contradict")
      return wrong.length ? wrong.join(', ') : null
    }
  }
]

interface Row {
  backend: string
  passed: number
  total: number
  failures: string[]
  seconds: number
  tokens: number
  fellBack: boolean
}

const rows: Row[] = []
after(() => {
  if (!rows.length) return
  const dir = join(process.cwd(), 'test-results', 'eval')
  mkdirSync(dir, { recursive: true })
  const file = `helpers-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(join(dir, file), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2))
  console.log('\nBackground-job eval (saving memory):')
  for (const r of rows) {
    console.log(
      `- ${r.backend}: ${r.passed}/${r.total} right · ${r.seconds.toFixed(1)} s per job · ${Math.round(r.tokens / r.total / 1000)}k tokens per job${r.fellBack ? ' · SOME JOBS FELL BACK (to Haiku or Cline)' : ''}${r.failures.length ? `\n    wrong: ${r.failures.join('; ')}` : ''}`
    )
  }
  console.log(`Saved to test-results/eval/${file}`)
})

if (WANTED === 'all') {
  test('background jobs: saving memory on every ClinePass model', { timeout: 240 * 60_000 }, async () => {
    const models = (await listClineModels(true)).models.map((m) => m.id)
    console.log(`  models: ${models.join(', ')}`)
    for (const model of models) await evaluate(model, false)
  })
} else {
  for (const backend of BACKENDS) {
    test(`background jobs: saving memory on ${backend}`, { timeout: 900_000 }, () => evaluate(backend, true))
  }
}

async function evaluate(backend: string, strict: boolean): Promise<void> {
  {
    const onLmStudio = backend === 'lmstudio' || backend.startsWith('lmstudio:')
    const onCline = !onLmStudio && backend !== 'haiku'
    updateSettings({
      lmStudioHelpers: onLmStudio,
      lmStudioModel: onLmStudio ? backend.slice('lmstudio:'.length) || null : null,
      clineHelpers: onCline,
      clineHelperModel: onCline ? backend : null,
      autoMemory: true
    })
    forgetLmStudioStatus()
    // Off Haiku, a job Haiku did instead (or, from LM Studio, Cline) is a fall-back.
    const fellBackRe = onLmStudio ? /^(scribe|tidy) \((claude|cline)\)$/ : /^(scribe|tidy) \(claude\)$/
    const row: Row = { backend, passed: 0, total: CASES.length + AGE_CASES.length, failures: [], seconds: 0, tokens: 0, fellBack: false }
    for (const c of CASES) {
      const pid = projectId(`helpers_${c.name.replace(/\W+/g, '_').slice(0, 20)}`)
      const db = memoryDb()
      const known = (c.known ?? []).map((text) => (rememberFact(db, pid, text, 'user', { category: 'setup', key: true }), { text }))
      const since = new Date(Date.now() - 1000).toISOString()
      const globalBefore = new Set(listFacts(db, GLOBAL_SCOPE).map((f) => f.id))
      const started = Date.now()
      let problem: string | null
      try {
        await runScribe(pid, c.turn)
        const facts = listFacts(db, pid).map((f) => ({ text: f.text, category: f.category }))
        const global = listFacts(db, GLOBAL_SCOPE).filter((f) => !globalBefore.has(f.id))
        problem = c.judge(facts, global.map((f) => ({ text: f.text, category: f.category })), known)
        // Global facts are shared by every case and model in this run: left in place, the
        // next model is shown the rule as already known and rightly saves nothing.
        for (const f of global) deleteFact(db, f.id)
      } catch (err) {
        problem = `failed: ${(err as Error).message.slice(0, 120)}`
      }
      row.seconds += (Date.now() - started) / 1000
      for (const u of usageSummary(db, since, pid)) {
        row.tokens += weight(u)
        if (backend !== 'haiku' && fellBackRe.test(u.kind)) row.fellBack = true
      }
      if (problem) row.failures.push(`${c.name}: ${problem}`)
      else row.passed++
    }
    for (const c of AGE_CASES) {
      const since = new Date(Date.now() - 1000).toISOString()
      const started = Date.now()
      let problem: string | null
      try {
        problem = await c.run()
      } catch (err) {
        problem = `failed: ${(err as Error).message.slice(0, 120)}`
      }
      row.seconds += (Date.now() - started) / 1000
      for (const u of usageSummary(memoryDb(), since)) {
        row.tokens += weight(u)
        if (backend !== 'haiku' && fellBackRe.test(u.kind)) row.fellBack = true
      }
      if (problem) row.failures.push(`${c.name}: ${problem}`)
      else row.passed++
    }
    row.seconds /= row.total
    rows.push(row)
    console.log(`  ${backend}: ${row.passed}/${row.total}${row.fellBack ? ' (some fell back)' : ''}`)
    if (strict) assert.ok(row.passed >= row.total - 1, `${backend}: ${row.failures.join('; ')}`)
  }
}
