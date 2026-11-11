import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { memoryDb } from '../../src/main/memory/paths'
import { deleteFact, GLOBAL_SCOPE, relevantCode, relevantFacts, rememberFact, saveCodeSummaries, searchCode, searchFacts } from '../../src/main/memory/store'
import { projectId } from '../support/fixtures'
import { FACTS, FACT_QUESTIONS, FILES, FILE_QUESTIONS, OFF_TOPIC, type SearchQuestion } from './searchCases'

// The memory search evaluation: a made-up project's facts and code map
// (searchCases.ts) and 120 questions with known answers, scored on whether
// the right fact or file is among the first five found. No network, no plan
// usage.
//
//   npm run eval -- search
//
// It measures the keyword search the app has, and can measure search by
// meaning next to it: give it a module that turns text into vectors
//   VIBEAPP_SEARCH_EMBEDDER=<file.cjs>   exports load(name) -> { embed(texts, 'query' | 'passage') -> Float32Array[] }, vectors of length 1
//   VIBEAPP_SEARCH_MODELS=a,b            the names to load
// and each model is scored alone and mixed with the keyword search.
//
// 2026-11-10 (0.5.5, the trial before building search by meaning): keyword 70% (93% of the
// questions that share a word with their answer, 0% of the 30 that don't). Meaning with a small
// local model 90-95% (gte-small 93-95%, all-MiniLM-L6-v2 92-93%). Details in ROADMAP.md, Memory v3 Step 2.

const EMBEDDER = process.env.VIBEAPP_SEARCH_EMBEDDER
const MODELS = (process.env.VIBEAPP_SEARCH_MODELS ?? '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean)

interface Embedder {
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>
}

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
const fileDocs: Doc[] = FILES.map((f) => ({ id: f.path, text: `${f.path}: ${f.summary}`, key: false }))
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
  /** Where the right answer came for each question (1 = first), null if not in the first 12. */
  ranks: Record<string, number | null>
}

const rows: Row[] = []

type Search = (q: Asked) => string[]

function score(method: string, search: Search): Row {
  const tally = (): Tally => ({ n: 0, top1: 0, top5: 0 })
  const row: Row = { method, all: tally(), facts: tally(), files: tally(), requests: tally(), queries: tally(), sharedWord: tally(), noSharedWord: tally(), ranks: {} }
  for (const q of QUESTIONS) {
    const at = search(q).slice(0, 12).findIndex((id) => q.answers.includes(id))
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

/** What the pre-fetch attaches: `attach` gives the facts and the files for a message. */
function scorePrefetch(attach: (text: string) => { facts: string[]; files: string[] }): Prefetch {
  const nonKey = new Set(factDocs.filter((d) => !d.key).map((d) => d.id))
  const out: Prefetch = { right: 0, of: 0, attached: 0, offTopic: 0, offTopicAttached: {} }
  const requests = QUESTIONS.filter((q) => q.from === 'request')
  for (const q of requests) {
    const got = attach(q.text)
    out.attached += got.facts.length + got.files.length
    const answers = q.target === 'fact' ? q.answers.filter((a) => nonKey.has(a)) : q.answers
    if (!answers.length) continue
    out.of++
    if ((q.target === 'fact' ? got.facts : got.files).some((id) => answers.includes(id))) out.right++
  }
  out.attached /= requests.length
  for (const text of OFF_TOPIC) {
    const got = attach(text)
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

test('keyword search (what the app does today)', () => {
  const row = score('keyword (today)', (q) => keyword(q.target, q.text, 12))
  row.prefetch = scorePrefetch((text) => ({
    facts: relevantFacts(db, pid, text, 5).map((f) => caseId.get(f.id) ?? f.id),
    files: relevantCode(db, pid, text, 5).map((f) => f.path)
  }))
  rows.push(row)
  assert.ok(row.sharedWord.top5 / row.sharedWord.n > 0.6, 'the keyword search misses most questions that share a word with their answer')
})

// ---- search by meaning --------------------------------------------------------------

const dot = (a: Float32Array, b: Float32Array): number => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

/**
 * Meaning order, with the keyword search's first find always among the first
 * five, so an exact name ("QuotaExceededError") is never lost. Merging the two
 * lists by position (reciprocal rank fusion, at several weightings) scored
 * below meaning alone on every model tried: a fact only one list has loses to
 * facts low in both.
 */
function mix(byKeyword: string[], byMeaning: string[]): string[] {
  const exact = byKeyword.slice(0, 1)
  const head = byMeaning.slice(0, 5).some((id) => exact.includes(id)) ? byMeaning.slice(0, 5) : [...byMeaning.slice(0, 5 - exact.length), ...exact]
  return [...new Set([...head, ...byMeaning, ...byKeyword])]
}

for (const name of EMBEDDER ? MODELS : []) {
  test(`search by meaning: ${name}`, { timeout: 30 * 60_000 }, async () => {
    const module = createRequire(join(process.cwd(), 'package.json'))(resolve(EMBEDDER!)) as { load(name: string): Promise<Embedder> }
    let started = Date.now()
    const model = await module.load(name)
    await model.embed(['warm up'], 'query')
    const loadSeconds = (Date.now() - started) / 1000

    const docs = { fact: factDocs, file: fileDocs }
    started = Date.now()
    const vectors = { fact: await model.embed(factDocs.map((d) => d.text), 'passage'), file: await model.embed(fileDocs.map((d) => d.text), 'passage') }
    const msPerSavedText = (Date.now() - started) / (factDocs.length + fileDocs.length)

    // One at a time, as a question arrives in the app.
    const asked = new Map<string, Float32Array>()
    started = Date.now()
    for (const text of new Set([...QUESTIONS.map((q) => q.text), ...OFF_TOPIC])) asked.set(text, (await model.embed([text], 'query'))[0])
    const msPerQuestion = (Date.now() - started) / asked.size

    const nearest = (target: Target, text: string, keep: (d: Doc) => boolean = () => true): { id: string; alike: number }[] =>
      docs[target]
        .map((d, i) => ({ d, alike: dot(asked.get(text)!, vectors[target][i]) }))
        .filter((x) => keep(x.d))
        .sort((x, y) => y.alike - x.alike)
        .map((x) => ({ id: x.d.id, alike: x.alike }))

    const meaning = score(`meaning: ${name}`, (q) => nearest(q.target, q.text).map((x) => x.id))
    const mixed = score(`keyword + meaning: ${name}`, (q) => mix(keyword(q.target, q.text, 20), nearest(q.target, q.text).slice(0, 20).map((x) => x.id)))

    // The pre-fetch needs a bar: how alike is alike enough to attach. Set here to the lowest
    // bar that attaches nothing to any off-topic message (so it is fitted to these messages).
    const notKey = (d: Doc): boolean => !d.key
    const bar = { fact: 0, file: 0 }
    for (const text of OFF_TOPIC) {
      bar.fact = Math.max(bar.fact, nearest('fact', text, notKey)[0].alike)
      bar.file = Math.max(bar.file, nearest('file', text)[0].alike)
    }
    const above = (target: Target, text: string): string[] =>
      nearest(target, text, target === 'fact' ? notKey : undefined)
        .filter((x) => x.alike > bar[target] + 0.0001)
        .slice(0, 5)
        .map((x) => x.id)
    meaning.prefetch = scorePrefetch((text) => ({ facts: above('fact', text), files: above('file', text) }))
    const both = (kw: string[], near: string[]): string[] => [...new Set([...kw, ...near])].slice(0, 5)
    mixed.prefetch = scorePrefetch((text) => ({
      facts: both(relevantFacts(db, pid, text, 5).map((f) => caseId.get(f.id) ?? f.id), above('fact', text)),
      files: both(relevantCode(db, pid, text, 5).map((f) => f.path), above('file', text))
    }))
    meaning.timing = { loadSeconds, msPerSavedText, msPerQuestion }
    rows.push(meaning, mixed)
  })
}
