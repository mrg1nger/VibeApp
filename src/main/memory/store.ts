import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { basename, dirname, join } from 'path'
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryFact } from '@shared/types'

// The shared memory: one SQLite file used by the app (Memory screen, key
// facts for prompts, tidy-up) and by every memory tool process (one per
// Claude session, one per Codex run). SQLite's WAL mode lets them all read
// and write at once. Uses Node's built-in SQLite, so there's nothing native
// to build. No Electron imports: the memory server bundles this file too.

/** Facts in the global scope apply to every project. */
export const GLOBAL_SCOPE = 'global'

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  key INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  classified INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  forgotten_at TEXT,
  forgotten_reason TEXT
);
CREATE INDEX IF NOT EXISTS facts_scope ON facts(scope, forgotten_at);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  text, content='facts', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE OF text ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO facts_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

const databases = new Map<string, DatabaseSync>()

export function openMemory(dbPath: string): DatabaseSync {
  const open = databases.get(dbPath)
  if (open) return open
  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(dbPath)
  // Several processes share the file: wait for each other instead of failing.
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  databases.set(dbPath, db)
  return db
}

export function closeMemory(): void {
  for (const db of databases.values()) db.close()
  databases.clear()
}

interface FactRow {
  id: string
  scope: string
  text: string
  category: string
  key: number
  source: string
  classified: number
  created_at: string
  updated_at: string
  last_used_at: string | null
  use_count: number
  forgotten_at: string | null
  forgotten_reason: string | null
}

function toFact(row: FactRow): MemoryFact {
  return {
    id: row.id,
    text: row.text,
    category: (MEMORY_CATEGORIES as readonly string[]).includes(row.category) ? (row.category as MemoryCategory) : 'other',
    key: row.key === 1,
    source: row.source as MemoryFact['source'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    forgottenAt: row.forgotten_at,
    forgottenReason: row.forgotten_reason
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function now(): string {
  return new Date().toISOString()
}

/** Facts needed on almost every request are key by default. */
export function defaultKey(category: MemoryCategory): boolean {
  return category === 'about' || category === 'setup' || category === 'preference'
}

export function normalizeCategory(category: unknown): MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(category as string) ? (category as MemoryCategory) : 'other'
}

// ---- search -------------------------------------------------------------

const STOPWORDS = new Set(
  'a an and are as at be by for from has have in is it its of on or that the this to was were will with uses use using'.split(' ')
)

function words(text: string): string[] {
  // Numbers count even when short: "level 1" and "level 2" are different facts.
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
    (w) => (w.length > 1 || /\d/.test(w)) && !STOPWORDS.has(w)
  )
}

function numbers(text: string): string {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).sort().join(',')
}

/** Any-word match, ranked by relevance. User text is quoted so it can't break the FTS syntax. */
function ftsQuery(text: string): string | null {
  const unique = [...new Set(words(text))].slice(0, 12)
  return unique.length ? unique.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ') : null
}

function similarity(a: string, b: string): number {
  // Facts that differ in their numbers (sizes, versions, ports) are never the same fact.
  if (numbers(a) !== numbers(b)) return 0
  const setA = new Set(words(a))
  const setB = new Set(words(b))
  if (!setA.size || !setB.size) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0
  let shared = 0
  for (const w of setA) if (setB.has(w)) shared++
  return shared / (setA.size + setB.size - shared)
}

/**
 * Best matches for a search across a project and the global scope. Marks
 * them as used, which the tidy-up takes into account.
 */
export function searchFacts(db: DatabaseSync, projectId: string, text: string, limit = 10): MemoryFact[] {
  const match = ftsQuery(text)
  if (!match) return []
  const rows = db
    .prepare(
      `SELECT facts.* FROM facts_fts JOIN facts ON facts.rowid = facts_fts.rowid
       WHERE facts_fts MATCH ? AND facts.forgotten_at IS NULL AND facts.scope IN (?, ?)
       ORDER BY bm25(facts_fts) LIMIT ?`
    )
    .all(match, projectId, GLOBAL_SCOPE, limit) as unknown as FactRow[]
  markUsed(db, rows.map((r) => r.id))
  return rows.map(toFact)
}

function markUsed(db: DatabaseSync, ids: string[]): void {
  if (!ids.length) return
  const stmt = db.prepare('UPDATE facts SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
  const at = now()
  for (const id of ids) stmt.run(at, id)
}

// ---- reading --------------------------------------------------------------

export function listFacts(db: DatabaseSync, scope: string, includeForgotten = false): MemoryFact[] {
  const rows = db
    .prepare(
      `SELECT * FROM facts WHERE scope = ? ${includeForgotten ? '' : 'AND forgotten_at IS NULL'}
       ORDER BY key DESC, category, created_at`
    )
    .all(scope) as unknown as FactRow[]
  return rows.map(toFact)
}

export function getFact(db: DatabaseSync, id: string): MemoryFact | null {
  const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as unknown as FactRow | undefined
  return row ? toFact(row) : null
}

export function countFacts(db: DatabaseSync, scope: string): { active: number; unclassified: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS active, SUM(CASE WHEN classified = 0 THEN 1 ELSE 0 END) AS unclassified
       FROM facts WHERE scope = ? AND forgotten_at IS NULL`
    )
    .get(scope) as { active: number; unclassified: number | null }
  return { active: row.active, unclassified: row.unclassified ?? 0 }
}

const KEY_FACT_LIMIT = 30
const KEY_FACT_CHARS = 3500

/**
 * The key facts for a project (and global preferences), formatted for an
 * agent's instructions, with ids so the agent can correct them.
 */
export function keyFactsBlock(db: DatabaseSync, projectId: string): string {
  const rows = db
    .prepare(
      `SELECT * FROM facts WHERE key = 1 AND forgotten_at IS NULL AND scope IN (?, ?)
       ORDER BY CASE scope WHEN ? THEN 0 ELSE 1 END, category, use_count DESC, created_at
       LIMIT ?`
    )
    .all(projectId, GLOBAL_SCOPE, projectId, KEY_FACT_LIMIT) as unknown as FactRow[]
  const lines: string[] = []
  let chars = 0
  for (const row of rows) {
    const line = `- [${row.category}${row.scope === GLOBAL_SCOPE ? ', all projects' : ''}] ${row.text} (id ${row.id})`
    if (chars + line.length > KEY_FACT_CHARS) break
    lines.push(line)
    chars += line.length
  }
  const total =
    countFacts(db, projectId).active + countFacts(db, GLOBAL_SCOPE).active - lines.length
  return [
    lines.length ? lines.join('\n') : '(No key facts yet.)',
    total > 0 ? `${total} more remembered fact${total === 1 ? ' is' : 's are'} searchable with recall.` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

// ---- writing --------------------------------------------------------------

export interface RememberResult {
  fact: MemoryFact
  /** The new fact matched an existing one closely, which was updated instead of adding a duplicate. */
  mergedInto: boolean
}

/** How alike two facts must be (shared-word overlap) to count as the same fact. */
const DUPLICATE_THRESHOLD = 0.7

export function rememberFact(
  db: DatabaseSync,
  scope: string,
  text: string,
  source: MemoryFact['source'],
  options: { category?: MemoryCategory; key?: boolean; classified?: boolean } = {}
): RememberResult {
  const clean = text.trim().slice(0, 1000)
  if (!clean) throw new Error('The fact is empty.')
  // One step, so two agents saving the same fact at once can't both miss
  // each other's copy.
  return transaction(db, () => rememberInTransaction(db, scope, clean, source, options))
}

function rememberInTransaction(
  db: DatabaseSync,
  scope: string,
  clean: string,
  source: MemoryFact['source'],
  options: { category?: MemoryCategory; key?: boolean; classified?: boolean }
): RememberResult {
  const category = normalizeCategory(options.category)
  const at = now()

  // Same fact already known (reworded, or updated with new detail)? Keep one
  // copy, with the newest wording.
  const match = ftsQuery(clean)
  if (match) {
    const candidates = db
      .prepare(
        `SELECT facts.* FROM facts_fts JOIN facts ON facts.rowid = facts_fts.rowid
         WHERE facts_fts MATCH ? AND facts.forgotten_at IS NULL AND facts.scope = ?
         ORDER BY bm25(facts_fts) LIMIT 5`
      )
      .all(match, scope) as unknown as FactRow[]
    const duplicate = candidates.find((c) => similarity(c.text, clean) >= DUPLICATE_THRESHOLD)
    if (duplicate) {
      db.prepare(
        `UPDATE facts SET text = ?, updated_at = ?, category = CASE WHEN ? = 'other' THEN category ELSE ? END,
           key = MAX(key, ?), classified = 1 WHERE id = ?`
      ).run(clean, at, category, category, options.key ? 1 : 0, duplicate.id)
      return { fact: getFact(db, duplicate.id)!, mergedInto: true }
    }
  }

  const id = newId()
  db.prepare(
    `INSERT INTO facts (id, scope, text, category, key, source, classified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    scope,
    clean,
    category,
    (options.key ?? defaultKey(category)) ? 1 : 0,
    source,
    options.classified === false ? 0 : 1,
    at,
    at
  )
  return { fact: getFact(db, id)!, mergedInto: false }
}

export function updateFact(
  db: DatabaseSync,
  id: string,
  patch: { text?: string; category?: MemoryCategory; key?: boolean }
): MemoryFact | null {
  const fact = getFact(db, id)
  if (!fact) return null
  db.prepare(
    `UPDATE facts SET text = ?, category = ?, key = ?, classified = 1, updated_at = ? WHERE id = ?`
  ).run(
    patch.text?.trim() ? patch.text.trim().slice(0, 1000) : fact.text,
    patch.category ? normalizeCategory(patch.category) : fact.category,
    (patch.key ?? fact.key) ? 1 : 0,
    now(),
    id
  )
  return getFact(db, id)
}

/** Soft delete: forgotten facts stay restorable from the Memory screen. */
export function forgetFact(db: DatabaseSync, id: string, reason: string): boolean {
  const result = db
    .prepare('UPDATE facts SET forgotten_at = ?, forgotten_reason = ? WHERE id = ? AND forgotten_at IS NULL')
    .run(now(), reason.slice(0, 200), id)
  return Number(result.changes) > 0
}

export function restoreFact(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('UPDATE facts SET forgotten_at = NULL, forgotten_reason = NULL WHERE id = ?').run(id)
  return Number(result.changes) > 0
}

/** Permanent delete (the user's Delete button). */
export function deleteFact(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM facts WHERE id = ?').run(id).changes) > 0
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value
  )
}

/** Runs several writes as one: all of them happen, or none. */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// ---- moving over from the JSON files ---------------------------------------

interface LegacyFact {
  id?: string
  text?: string
  createdAt?: string
  source?: string
}

/**
 * One-time move of the old JSON memory files into the database. The files
 * are left where they are as a backup. Imported facts are marked
 * unclassified, so the first tidy-up sorts them into categories.
 */
export function importLegacyMemory(db: DatabaseSync, globalJson: string, projectsDir: string): number {
  if (getMeta(db, 'legacy_imported')) return 0
  const sources: { scope: string; file: string }[] = []
  if (existsSync(globalJson)) sources.push({ scope: GLOBAL_SCOPE, file: globalJson })
  if (existsSync(projectsDir)) {
    for (const name of readdirSync(projectsDir).filter((f) => f.endsWith('.json'))) {
      sources.push({ scope: basename(name, '.json'), file: join(projectsDir, name) })
    }
  }
  let imported = 0
  transaction(db, () => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO facts (id, scope, text, category, key, source, classified, created_at, updated_at)
       VALUES (?, ?, ?, 'other', 0, ?, 0, ?, ?)`
    )
    for (const { scope, file } of sources) {
      let facts: LegacyFact[] = []
      try {
        facts = (JSON.parse(readFileSync(file, 'utf-8')) as { facts?: LegacyFact[] }).facts ?? []
      } catch {
        continue // unreadable file: leave it for the user, it's still on disk
      }
      for (const f of facts) {
        if (!f.text?.trim()) continue
        const at = f.createdAt ?? now()
        const source = ['claude', 'codex', 'user'].includes(f.source ?? '') ? f.source! : 'user'
        insert.run(f.id ?? newId(), scope, f.text.trim(), source, at, at)
        imported++
      }
    }
    setMeta(db, 'legacy_imported', now())
  })
  return imported
}
