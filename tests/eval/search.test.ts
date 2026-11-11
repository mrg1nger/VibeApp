import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { loadEmbedder } from '../../src/main/memory/embedder'
import type { MemoryFact } from '@shared/types'
import {
  CLOSE,
  factsForRequest,
  filesForRequest,
  fillVectorsInBackground,
  findCode,
  NEAR,
  recallFacts,
  searchesByMeaning
} from '../../src/main/memory/meaning'
import { memoryDb, searchModelFolder } from '../../src/main/memory/paths'
import {
  deleteFact,
  GLOBAL_SCOPE,
  nearestCode,
  nearestFacts,
  relevantCode,
  relevantFacts,
  rememberFact,
  saveCodeSummaries,
  searchCode,
  searchFacts
} from '../../src/main/memory/store'
import { projectId } from '../support/fixtures'
import { FACTS, FACT_QUESTIONS, FILES, FILE_QUESTIONS, OFF_TOPIC, type SearchQuestion } from './searchCases'

// The memory search evaluation: a made-up project's facts and code map
// (searchCases.ts) and 120 questions with known answers, scored on whether
// the right fact or file is among the first five found. No network, no plan
// usage; the language model runs on this computer.
//
//   npm run eval -- search
//
// It scores the app's own search (by meaning, meaning.ts) next to the keyword
// search it replaced, which is still what runs when the model can't, and fails
// if the app's search drops below what it scored when it was built.
//
// 2026-11-10 (0.5.5, the trial before building search by meaning): keyword 70% (93% of the
// questions that share a word with their answer, 0% of the 30 that don't). Meaning with a small
// local model 90-95% (gte-small 93-95%, all-MiniLM-L6-v2 92-93%). Details in ROADMAP.md, Memory v3 Step 2.
//
// 2026-11-10 (0.6.0, search by meaning built in, gte-small): the app's search 93% (78% first;
// 98% with a shared word, 80% without). Pre-fetch: the right fact or file attached to 38 of 60
// requests with 2.5 items each and nothing for the 8 off-topic messages (keyword: 35 of 60,
// 5.8 items each, 5 of 8 off-topic messages got something).

interface Doc {
  id: string
  text: string
  /** Key facts are in every request already, so the pre-fetch leaves them out. */
  key: boolean
}

type Target = 'fact' | 'file'
interface Asked extends SearchQuestion {
  target: Target
}
const QUESTIONS: Asked[] = [...FACT_QUESTIONS.map((q) => ({ ...q, target: 'fact' as const })), ...FILE_QUESTIONS.map((q) => ({ ...q, target: 'file' as const }))]

const db = memoryDb()
const pid = projectId('search')
const factDocs: Doc[] = []
/** The database's fact ids, as the ids in searchCases.ts. */
const caseId = new Map<string, string>()
const globalIds: string[] = []
/** Questions that share a word with an answer: the only ones a keyword search can find. */
const findable = new Set<string>()

before(() => {
  for (const f of FACTS) {
    const saved = rememberFact(db, f.global ? GLOBAL_SCOPE : pid, f.text, 'user', { category: f.category })
    assert.equal(saved.mergedInto, false, `"${f.id}" was merged into another fact: the test facts must all be different`)
    caseId.set(saved.fact.id, f.id)
    factDocs.push({ id: f.id, text: f.text, key: saved.fact.key })
    if (f.global) globalIds.push(saved.fact.id)
  }
  saveCodeSummaries(db, pid, FILES.map((f) => ({ ...f, hash: 'x' })))
  const known = new Set([...FACTS.map((f) => f.id), ...FILES.map((f) => f.path)])
  for (const q of QUESTIONS) {
    for (const a of q.answers) assert.ok(known.has(a), `"${q.text}" names an answer that doesn't exist: ${a}`)
    if (keyword(q.target, q.text, 1000).some((id) => q.answers.includes(id))) findable.add(q.text)
  }
})
after(() => {
  for (const id of globalIds) deleteFact(db, id)
})

function keyword(target: Target, text: string, limit: number): string[] {
  return target === 'fact' ? searchFacts(db, pid, text, limit).map((f) => caseId.get(f.id) ?? f.id) : searchCode(db, pid, text, limit).map((f) => f.path)
}

// ---- scoring ------------------------------------------------------------------

interface Tally {
  n: number
  top1: number
  top5: number
}

interface Prefetch {
  /** Requests where the right fact or file was attached, of those where it could be. */
  right: number
  of: number
  /** Facts and files attached to a request, on average. */
  attached: number
  /** Off-topic messages that got something attached. */
  offTopic: number
  /** What they got. */
  offTopicAttached: Record<string, string[]>
}

interface Row {
  method: string
  all: Tally
  facts: Tally
  files: Tally
  requests: Tally
  queries: Tally
  /** By whether the question shares a word with its answer. */
  sharedWord: Tally
  noSharedWord: Tally
  prefetch?: Prefetch
  timing?: { loadSeconds: number; msPerSavedText: number; msPerQuestion: number }
  /** What other bars would attach (the app's search only): one bar alone, or "close / near" (near counts when the keyword pre-fetch agrees). */
  bars?: Record<string, Prefetch>
  /** The five nearest facts and files for each request and off-topic message, with how alike they are. */
  nearest?: Record<string, unknown>
  /** Where the right answer came for each question (1 = first), null if not in the first 12. */
  ranks: Record<string, number | null>
}

const rows: Row[] = []

type Search = (q: Asked) => string[] | Promise<string[]>

async function score(method: string, search: Search): Promise<Row> {
  const tally = (): Tally => ({ n: 0, top1: 0, top5: 0 })
  const row: Row = { method, all: tally(), facts: tally(), files: tally(), requests: tally(), queries: tally(), sharedWord: tally(), noSharedWord: tally(), ranks: {} }
  for (const q of QUESTIONS) {
    const at = (await search(q)).slice(0, 12).findIndex((id) => q.answers.includes(id))
    const rank = at < 0 ? null : at + 1
    row.ranks[`${q.target}: ${q.text}`] = rank
    const groups = [row.all, q.target === 'fact' ? row.facts : row.files, q.from === 'request' ? row.requests : row.queries, findable.has(q.text) ? row.sharedWord : row.noSharedWord]
    for (const t of groups) {
      t.n++
      if (rank === 1) t.top1++
      if (rank !== null && rank <= 5) t.top5++
    }
  }
  return row
}

interface Attached {
  facts: string[]
  files: string[]
}

/** What the pre-fetch attaches: `attach` gives the facts and the files for a message. */
async function scorePrefetch(attach: (text: string) => Attached | Promise<Attached>): Promise<Prefetch> {
  const nonKey = new Set(factDocs.filter((d) => !d.key).map((d) => d.id))
  const out: Prefetch = { right: 0, of: 0, attached: 0, offTopic: 0, offTopicAttached: {} }
  const requests = QUESTIONS.filter((q) => q.from === 'request')
  for (const q of requests) {
    const got = await attach(q.text)
    out.attached += got.facts.length + got.files.length
    const answers = q.target === 'fact' ? q.answers.filter((a) => nonKey.has(a)) : q.answers
    if (!answers.length) continue
    out.of++
    if ((q.target === 'fact' ? got.facts : got.files).some((id) => answers.includes(id))) out.right++
  }
  out.attached /= requests.length
  for (const text of OFF_TOPIC) {
    const got = await attach(text)
    if (!(got.facts.length + got.files.length)) continue
    out.offTopic++
    out.offTopicAttached[text] = [...got.facts, ...got.files]
  }
  return out
}

const pct = (t: Tally, k: 'top1' | 'top5'): string => (t.n ? `${Math.round((t[k] / t.n) * 100)}%`.padStart(4) : '   -')

after(() => {
  if (!rows.length) return
  const dir = join(process.cwd(), 'test-results', 'eval')
  mkdirSync(dir, { recursive: true })
  const file = `search-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(join(dir, file), JSON.stringify({ at: new Date().toISOString(), facts: FACTS.length, files: FILES.length, rows }, null, 2))
  const first = rows[0]
  console.log(`\nMemory search eval: ${FACTS.length} facts, ${FILES.length} files, ${first.all.n} questions (${first.noSharedWord.n} share no word with their answer).`)
  console.log('Right answer in the first five (and first):')
  console.log(`${'method'.padEnd(34)}  all          facts  files  requests  queries  shared word  no shared word`)
  for (const r of rows) {
    console.log(
      `${r.method.padEnd(34)} ${pct(r.all, 'top5')} (${pct(r.all, 'top1').trim()} 1st)  ${pct(r.facts, 'top5')}   ${pct(r.files, 'top5')}   ${pct(r.requests, 'top5')}      ${pct(r.queries, 'top5')}     ${pct(r.sharedWord, 'top5')}         ${pct(r.noSharedWord, 'top5')}`
    )
  }
  console.log('\nPre-fetch (what is attached to a request before the agent starts):')
  for (const r of rows) {
    if (!r.prefetch) continue
    const p = r.prefetch
    console.log(`${r.method.padEnd(34)} right one attached ${p.right}/${p.of} · ${p.attached.toFixed(1)} items per request · ${p.offTopic}/${OFF_TOPIC.length} off-topic messages got something`)
  }
  for (const r of rows) {
    if (r.timing) console.log(`${r.method}: loads in ${r.timing.loadSeconds.toFixed(1)} s · ${r.timing.msPerSavedText.toFixed(1)} ms per saved text · ${r.timing.msPerQuestion.toFixed(1)} ms per question`)
  }
  console.log(`Saved to test-results/eval/${file}`)
})

// ---- the keyword search the app has ----------------------------------------------

test('keyword search (what the app did before 0.6.0, and still does without the model)', async () => {
  const row = await score('keyword', (q) => keyword(q.target, q.text, 12))
  row.prefetch = await scorePrefetch((text) => ({
    facts: relevantFacts(db, pid, text, 5).map((f) => caseId.get(f.id) ?? f.id),
    files: relevantCode(db, pid, text, 5).map((f) => f.path)
  }))
  rows.push(row)
  assert.ok(row.sharedWord.top5 / row.sharedWord.n > 0.6, 'the keyword search misses most questions that share a word with their answer')
})


// ---- the app's search, by meaning ------------------------------------------------

/** A little under what it scored when built (0.6.0, see the top of this file). */
const FLOOR = { all: 0.9, sharedWord: 0.95, noSharedWord: 0.7, prefetchRight: 35, offTopic: 1 }

test("the app's search (by meaning)", { timeout: 10 * 60_000 }, async () => {
  let started = Date.now()
  assert.equal(await searchesByMeaning(), true, 'the language model did not load (scripts/fetch-model.mjs puts it in resources/models)')
  const loadSeconds = (Date.now() - started) / 1000

  // Every fact and file gets its vector first, as the app does in the background when it starts.
  started = Date.now()
  await fillVectorsInBackground(db)
  const msPerSavedText = (Date.now() - started) / (FACTS.length + FILES.length)

  const facts = (found: MemoryFact[]): string[] => found.map((f) => caseId.get(f.id) ?? f.id)
  started = Date.now()
  const row = await score("the app's search (meaning)", async (q) =>
    q.target === 'fact' ? facts(await recallFacts(db, pid, q.text, 12)) : (await findCode(db, pid, q.text, 12)).map((f) => f.path)
  )
  const msPerQuestion = (Date.now() - started) / QUESTIONS.length
  row.timing = { loadSeconds, msPerSavedText, msPerQuestion }
  row.prefetch = await scorePrefetch(async (text) => ({
    facts: facts(await factsForRequest(db, pid, text, 5)),
    files: (await filesForRequest(db, pid, text, 5)).map((f) => f.path)
  }))

  // What other bars would attach, to show how much hangs on the ones chosen (CLOSE and NEAR in meaning.ts).
  interface Near {
    id: string
    alike: number
    /** The keyword pre-fetch picked it too. */
    keywordToo: boolean
  }
  const model = await loadEmbedder(searchModelFolder())
  const near = new Map<string, { facts: Near[]; files: Near[] }>()
  for (const text of new Set([...QUESTIONS.filter((q) => q.from === 'request').map((q) => q.text), ...OFF_TOPIC])) {
    const v = await model.embed(text)
    const keywordFacts = new Set(relevantFacts(db, pid, text, 5, false).map((f) => f.id))
    const keywordFiles = new Set(relevantCode(db, pid, text, 5).map((f) => f.path))
    near.set(text, {
      facts: nearestFacts(db, pid, model.model, v, 5, true).map((n) => ({ id: caseId.get(n.fact.id) ?? n.fact.id, alike: n.similarity, keywordToo: keywordFacts.has(n.fact.id) })),
      files: nearestCode(db, pid, model.model, v, 5).map((n) => ({ id: n.file.path, alike: n.similarity, keywordToo: keywordFiles.has(n.file.path) }))
    })
  }
  row.bars = {}
  const pairs = [[0.8, 0.8], [0.82, 0.82], [0.84, 0.84], [0.86, 0.86], [0.83, 0.79], [0.84, 0.78], [CLOSE, NEAR], [0.84, 0.82], [0.85, 0.8], [0.86, 0.8]]
  for (const [close, nearBar] of pairs) {
    const over = (items: Near[]): string[] => items.filter((x) => x.alike >= close || (x.keywordToo && x.alike >= nearBar)).map((x) => x.id)
    const name = close === nearBar ? `${close.toFixed(2)} alone` : `${close.toFixed(2)} / ${nearBar.toFixed(2)}`
    row.bars[name] = await scorePrefetch((text) => ({ facts: over(near.get(text)!.facts), files: over(near.get(text)!.files) }))
  }
  row.nearest = Object.fromEntries(near)
  rows.push(row)

  console.log(`\nThe pre-fetch at other bars (the app uses ${CLOSE.toFixed(2)} / ${NEAR.toFixed(2)}: that alike on its own, or the second number when the keyword pre-fetch picked it too):`)
  for (const [bar, p] of Object.entries(row.bars)) {
    console.log(`  ${bar.padEnd(11)}: right one attached ${p.right}/${p.of} · ${p.attached.toFixed(1)} items per request · ${p.offTopic}/${OFF_TOPIC.length} off-topic messages got something`)
  }

  // It must not get worse unnoticed.
  const share = (t: Tally): number => t.top5 / t.n
  assert.ok(share(row.all) >= FLOOR.all, `right answer in the first five for ${Math.round(share(row.all) * 100)}% of questions, below ${FLOOR.all * 100}%`)
  assert.ok(share(row.noSharedWord) >= FLOOR.noSharedWord, `only ${Math.round(share(row.noSharedWord) * 100)}% of the questions that share no word with their answer`)
  assert.ok(share(row.sharedWord) >= FLOOR.sharedWord, `only ${Math.round(share(row.sharedWord) * 100)}% of the questions that share a word with their answer`)
  assert.ok(row.prefetch.right >= FLOOR.prefetchRight, `the right fact or file was attached to only ${row.prefetch.right} of ${row.prefetch.of} requests`)
  assert.ok(row.prefetch.offTopic <= FLOOR.offTopic, `${row.prefetch.offTopic} off-topic messages got something attached`)
})
