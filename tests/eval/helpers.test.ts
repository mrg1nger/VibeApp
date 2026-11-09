import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runScribe, type TurnRecord } from '../../src/main/memory/scribe'
import { memoryDb } from '../../src/main/memory/paths'
import { GLOBAL_SCOPE, listFacts, rememberFact, usageSummary } from '../../src/main/memory/store'
import { updateSettings } from '../../src/main/settings/store'
import { weight } from '../../src/main/usage/report'
import { projectId } from '../support/fixtures'

// The background-job evaluation: the same memory-saving cases on Haiku and on
// Cline (each model named), scored on getting them right, with time and
// tokens. Saving memory is the background job that runs most and matters
// most (a wrong fact misleads every later request).
//
//   npm run eval -- helpers
//   VIBEAPP_EVAL_HELPERS="haiku,cline-pass/glm-5.3-flash" npm run eval -- helpers

const BACKENDS = (process.env.VIBEAPP_EVAL_HELPERS ?? 'haiku,cline-pass/glm-5.3-flash,cline-pass/deepseek-v4.1-flash-1017,cline-pass/qwen3.7-plus')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean)

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
      `- ${r.backend}: ${r.passed}/${r.total} right · ${r.seconds.toFixed(1)} s per job · ${Math.round(r.tokens / r.total / 1000)}k tokens per job${r.fellBack ? ' · SOME JOBS FELL BACK TO HAIKU' : ''}${r.failures.length ? `\n    wrong: ${r.failures.join('; ')}` : ''}`
    )
  }
  console.log(`Saved to test-results/eval/${file}`)
})

for (const backend of BACKENDS) {
  test(`background jobs: saving memory on ${backend}`, { timeout: 900_000 }, async () => {
    const onCline = backend !== 'haiku'
    updateSettings({ clineHelpers: onCline, clineHelperModel: onCline ? backend : null, autoMemory: true })
    const row: Row = { backend, passed: 0, total: CASES.length, failures: [], seconds: 0, tokens: 0, fellBack: false }
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
        const global = listFacts(db, GLOBAL_SCOPE).filter((f) => !globalBefore.has(f.id)).map((f) => ({ text: f.text, category: f.category }))
        problem = c.judge(facts, global, known)
      } catch (err) {
        problem = `failed: ${(err as Error).message.slice(0, 120)}`
      }
      row.seconds += (Date.now() - started) / 1000
      for (const u of usageSummary(db, since, pid)) {
        row.tokens += weight(u)
        if (onCline && u.kind === 'scribe (claude)') row.fellBack = true
      }
      if (problem) row.failures.push(`${c.name}: ${problem}`)
      else row.passed++
    }
    row.seconds /= CASES.length
    rows.push(row)
    assert.ok(row.passed >= CASES.length - 1, `${backend}: ${row.failures.join('; ')}`)
  })
}
