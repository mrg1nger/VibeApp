import type { DatabaseSync } from 'node:sqlite'
import type { MemoryFact } from '@shared/types'
import { loadEmbedder, type Embedder } from './embedder'
import { searchModelFolder } from './paths'
import {
  codeText,
  comparesVectorsInDatabase,
  factsMissingVectors,
  filesMissingVectors,
  GLOBAL_SCOPE,
  markUsed,
  nearestCode,
  nearestFacts,
  relevantCode,
  relevantFacts,
  saveCodeVector,
  saveFactVector,
  searchCode,
  searchFacts,
  vectorCoverage,
  type CodeFile
} from './store'

// Memory search by meaning. Every fact and every file summary has a vector
// (embedder.ts makes them, the store keeps them); a search turns the question
// into a vector too and takes what lies closest, so the wording no longer has
// to match: "put it online" finds the fact about deploying.
//
// It runs in the app only. When the model can't be used (not fetched, a
// computer the runtime doesn't support) or a project's vectors aren't made
// yet, every function here answers with the keyword search instead.

/**
 * How alike a fact or file must be to a request to be attached to it unasked (1 = means the
 * same): CLOSE on its own, or NEAR when the keyword pre-fetch picked it too. Two signs
 * agreeing can be trusted at a lower bar than one, and how alike "alike" is shifts from
 * project to project. Measured, not guessed: see tests/eval/search.test.ts and ROADMAP.md
 * (Memory v3, Step 2). Otherwise nothing is attached, which is right for "yes please".
 */
export const CLOSE = 0.84
export const NEAR = 0.8

export const attaches = (similarity: number, keywordToo: boolean): boolean => similarity >= CLOSE || (keywordToo && similarity >= NEAR)

/** A search waits this long for missing vectors (a handful of new facts), then uses keywords this once. */
const WAIT_FOR_VECTORS_MS = 1200

let loading: Promise<Embedder | null> | undefined
/** Tests put their own in (or null for "no model"). */
let injected: Embedder | null | undefined

export function setEmbedderForTests(embedder: Embedder | null | undefined): void {
  injected = embedder
  asked.clear()
}

function embedder(): Promise<Embedder | null> {
  if (injected !== undefined) return Promise.resolve(injected)
  if (process.env.VIBEAPP_MEANING === 'off') return Promise.resolve(null)
  loading ??= loadEmbedder(searchModelFolder()).catch((err) => {
    console.warn('Memory search by meaning is off, searching by keyword instead:', (err as Error).message)
    return null
  })
  return loading
}

/** Whether memory is searched by meaning on this computer (false: by keyword). */
export async function searchesByMeaning(): Promise<boolean> {
  return (await embedder()) !== null
}

/** The last questions' vectors: a request is searched for facts and for files, and often handed on with the same words. */
const asked = new Map<string, Float32Array>()

async function questionVector(e: Embedder, text: string): Promise<Float32Array> {
  const key = `${e.model}\n${text}`
  const known = asked.get(key)
  if (known) return known
  const vector = await e.embed(text)
  asked.set(key, vector)
  if (asked.size > 40) asked.delete(asked.keys().next().value!)
  return vector
}

/**
 * Makes the vectors that are missing: for one project and the global facts, or for everything
 * (projectId null). False if `withinMs` ran out first.
 */
async function fillVectors(db: DatabaseSync, e: Embedder, projectId: string | null, withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs
  const scopes = projectId === null ? null : [projectId, GLOBAL_SCOPE]
  // Fifty at a time. A batch that starts where the last one did made no headway (its texts keep changing): stop there.
  for (let first: string | undefined; ; ) {
    const facts = factsMissingVectors(db, e.model, scopes, 50)
    if (!facts.length || facts[0].id === first) break
    first = facts[0].id
    for (const fact of facts) {
      if (Date.now() > until) return false
      saveFactVector(db, e.model, fact, await e.embed(fact.text))
    }
  }
  for (let first: number | undefined; ; ) {
    const files = filesMissingVectors(db, e.model, projectId, 50)
    if (!files.length || files[0].id === first) break
    first = files[0].id
    for (const file of files) {
      if (Date.now() > until) return false
      saveCodeVector(db, e.model, file, await e.embed(codeText(file)))
    }
  }
  return true
}

let filling: Promise<void> | undefined

/**
 * Makes every missing vector in the background: at startup (the first time, all of memory;
 * about a hundredth of a second per fact or file) and after the code map changes.
 */
export function fillVectorsInBackground(db: DatabaseSync): Promise<void> {
  filling ??= (async () => {
    try {
      const e = await embedder()
      if (e) await fillVectors(db, e, null, Infinity)
    } catch (err) {
      console.warn('Making the search vectors failed:', (err as Error).message)
    } finally {
      filling = undefined
    }
  })()
  return filling
}

export interface SearchStatus {
  /** False: the model can't run here, and memory is searched by keyword. */
  byMeaning: boolean
  model: string | null
  /** Whether the sqlite-vec add-on does the comparing (otherwise plain JavaScript, with the same result). */
  addOn: boolean
  facts: number
  factsDone: number
  files: number
  filesDone: number
  at: string
}

/** How memory is searched on this computer right now, and how many vectors are made. */
export async function searchStatus(db: DatabaseSync): Promise<SearchStatus> {
  const e = await embedder()
  const coverage = e ? vectorCoverage(db, e.model) : { facts: 0, factsDone: 0, files: 0, filesDone: 0 }
  return { byMeaning: !!e, model: e?.model ?? null, addOn: comparesVectorsInDatabase(db), ...coverage, at: new Date().toISOString() }
}

interface Ready {
  model: string
  question: Float32Array
}

/** The question as a vector, once the project's facts and files all have theirs. Null: search by keyword. */
async function ready(db: DatabaseSync, projectId: string, text: string): Promise<Ready | null> {
  if (!text.trim()) return null
  const e = await embedder()
  if (!e) return null
  if (!(await fillVectors(db, e, projectId, WAIT_FOR_VECTORS_MS))) {
    void fillVectorsInBackground(db)
    return null
  }
  return { model: e.model, question: await questionVector(e, text) }
}

/**
 * Meaning order, with the keyword search's first find always among the first five, so an
 * exact name ("QuotaExceededError") is never lost. (Merging the two lists by position scored
 * below meaning alone in the trial.)
 */
function withExactMatch<T>(byMeaning: T[], exact: T | undefined, id: (item: T) => string, limit: number): T[] {
  if (!exact || byMeaning.slice(0, 5).some((item) => id(item) === id(exact))) return byMeaning.slice(0, limit)
  const rest = byMeaning.filter((item) => id(item) !== id(exact))
  return [...rest.slice(0, 4), exact, ...rest.slice(4)].slice(0, limit)
}

function keywordInstead(what: string, err: unknown): void {
  console.warn(`${what} by meaning failed, searching by keyword instead:`, (err as Error).message)
}

/** A search an agent asked for (the recall tool): the best matches in this project and the global facts. */
export async function recallFacts(db: DatabaseSync, projectId: string, text: string, limit = 10): Promise<MemoryFact[]> {
  try {
    const r = await ready(db, projectId, text)
    if (r) {
      const near = nearestFacts(db, projectId, r.model, r.question, limit).map((n) => n.fact)
      const found = withExactMatch(near, searchFacts(db, projectId, text, 1, false)[0], (f) => f.id, limit)
      markUsed(db, found.map((f) => f.id))
      return found
    }
  } catch (err) {
    keywordInstead('Searching memory', err)
  }
  return searchFacts(db, projectId, text, limit)
}

/** The where tool: the mapped files that best fit the question. */
export async function findCode(db: DatabaseSync, projectId: string, text: string, limit = 8): Promise<CodeFile[]> {
  try {
    const r = await ready(db, projectId, text)
    if (r) {
      const near = nearestCode(db, projectId, r.model, r.question, limit).map((n) => n.file)
      return withExactMatch(near, searchCode(db, projectId, text, 1)[0], (f) => f.path, limit)
    }
  } catch (err) {
    keywordInstead('Searching the code map', err)
  }
  return searchCode(db, projectId, text, limit)
}

/**
 * Facts to put in front of an agent with a request, so it needn't search: only those close
 * enough in meaning (see CLOSE and NEAR), and never key facts (they are in its instructions already).
 */
export async function factsForRequest(db: DatabaseSync, projectId: string, text: string, limit = 5): Promise<MemoryFact[]> {
  try {
    const r = await ready(db, projectId, text)
    if (r) {
      const keyword = new Set(relevantFacts(db, projectId, text, limit, false).map((f) => f.id))
      const found = nearestFacts(db, projectId, r.model, r.question, limit, true)
        .filter((n) => attaches(n.similarity, keyword.has(n.fact.id)))
        .map((n) => n.fact)
      markUsed(db, found.map((f) => f.id))
      return found
    }
  } catch (err) {
    keywordInstead('Finding facts for the request', err)
  }
  return relevantFacts(db, projectId, text, limit)
}

/** Files to put in front of an agent with a request, chosen the same way. */
export async function filesForRequest(db: DatabaseSync, projectId: string, text: string, limit = 5): Promise<CodeFile[]> {
  try {
    const r = await ready(db, projectId, text)
    if (r) {
      const keyword = new Set(relevantCode(db, projectId, text, limit).map((f) => f.path))
      return nearestCode(db, projectId, r.model, r.question, limit)
        .filter((n) => attaches(n.similarity, keyword.has(n.file.path)))
        .map((n) => n.file)
    }
  } catch (err) {
    keywordInstead('Finding files for the request', err)
  }
  return relevantCode(db, projectId, text, limit)
}

const isConvention = (f: MemoryFact): boolean => f.category === 'preference' || f.category === 'gotcha' || f.category === 'decision'

/**
 * Remembered conventions and decisions that bear on a change: related preferences, gotchas
 * and decisions that aren't already among the key facts every request starts with.
 */
export async function conventionsFor(db: DatabaseSync, projectId: string, text: string, limit = 4): Promise<MemoryFact[]> {
  try {
    const r = await ready(db, projectId, text)
    if (r) {
      const keyword = new Set(relevantFacts(db, projectId, text, 10, false).map((f) => f.id))
      const found = nearestFacts(db, projectId, r.model, r.question, 40, true)
        .filter((n) => isConvention(n.fact) && attaches(n.similarity, keyword.has(n.fact.id)))
        .slice(0, limit)
        .map((n) => n.fact)
      markUsed(db, found.map((f) => f.id))
      return found
    }
  } catch (err) {
    keywordInstead('Finding conventions', err)
  }
  return relevantFacts(db, projectId, text, 10).filter(isConvention).slice(0, limit)
}
