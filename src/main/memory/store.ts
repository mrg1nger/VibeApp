import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryFact, type TodoItem } from '@shared/types'

// The shared memory: one SQLite file used by the app (Memory screen, key
// facts for prompts, tidy-up) and by every memory tool process (one per
// Claude session, one per Codex run). SQLite's WAL mode lets them all read
// and write at once. Uses Node's built-in SQLite, so there's nothing native
// to build. No Electron imports: the memory server bundles this file too.

/** Facts in the global scope apply to every project. */
export const GLOBAL_SCOPE = 'global'

const SCHEMA_VERSION = 3

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

-- The conversation: what the user asked and what the agents answered.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_project ON messages(project_id, id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, note, content='messages', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, note) VALUES (new.id, new.text, new.note);
END;

-- Work handed from Claude to another agent, and what came back.
CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'codex',
  brief TEXT NOT NULL,
  request TEXT,
  report TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  files TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS handoffs_project ON handoffs(project_id, id);

-- A one-line summary of each source file, so agents can find where things live.
CREATE TABLE IF NOT EXISTS code_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  summary TEXT NOT NULL,
  hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, path)
);
CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
  path, summary, content='code_files', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS code_ai AFTER INSERT ON code_files BEGIN
  INSERT INTO code_fts(rowid, path, summary) VALUES (new.id, new.path, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS code_ad AFTER DELETE ON code_files BEGIN
  INSERT INTO code_fts(code_fts, rowid, path, summary) VALUES ('delete', old.id, old.path, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS code_au AFTER UPDATE OF summary, path ON code_files BEGIN
  INSERT INTO code_fts(code_fts, rowid, path, summary) VALUES ('delete', old.id, old.path, old.summary);
  INSERT INTO code_fts(rowid, path, summary) VALUES (new.id, new.path, new.summary);
END;

-- What each piece of work cost, so savings can be measured instead of guessed.
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  fresh INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL DEFAULT 1,
  cost_usd REAL
);
CREATE INDEX IF NOT EXISTS usage_at ON usage_log(at);

-- One row per Build/Plan request: who did what (Claude's steps by kind, hand-offs) and what it cost.
CREATE TABLE IF NOT EXISTS request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL,
  balance TEXT,
  route TEXT,
  size TEXT,
  model TEXT,
  text TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  claude_steps INTEGER NOT NULL DEFAULT 0,
  tools TEXT NOT NULL DEFAULT '{}',
  handoffs INTEGER NOT NULL DEFAULT 0,
  claude_fresh INTEGER NOT NULL DEFAULT 0,
  claude_cached INTEGER NOT NULL DEFAULT 0,
  claude_output INTEGER NOT NULL DEFAULT 0,
  codex_fresh INTEGER NOT NULL DEFAULT 0,
  codex_cached INTEGER NOT NULL DEFAULT 0,
  codex_output INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS request_at ON request_log(at);

-- The user's own to-do list and notes for each project (the agents can add to-dos and read both).
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS todos_project ON todos(project_id, done, position);
CREATE TABLE IF NOT EXISTS notes (
  project_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
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
  // Columns added after a table first shipped.
  const requestColumns = new Set((db.prepare('PRAGMA table_info(request_log)').all() as { name: string }[]).map((c) => c.name))
  for (const column of ['cline_fresh', 'cline_cached', 'cline_output']) {
    if (!requestColumns.has(column)) db.exec(`ALTER TABLE request_log ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`)
  }
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

// ---- relevant facts, pre-fetched ---------------------------------------------

/**
 * Facts that look relevant to a request, for putting in front of an agent
 * so it doesn't have to spend a tool call searching. Key facts are left out
 * (they're already in the agent's instructions). A match must share at
 * least two meaningful words with the request (one, for very short ones):
 * a single common word shouldn't pull in unrelated facts.
 */
export function relevantFacts(db: DatabaseSync, projectId: string, text: string, limit = 5): MemoryFact[] {
  const match = ftsQuery(text)
  if (!match) return []
  const asked = new Set(stems(text))
  const rows = db
    .prepare(
      `SELECT facts.* FROM facts_fts JOIN facts ON facts.rowid = facts_fts.rowid
       WHERE facts_fts MATCH ? AND facts.forgotten_at IS NULL AND facts.key = 0 AND facts.scope IN (?, ?)
       ORDER BY bm25(facts_fts) LIMIT 20`
    )
    .all(match, projectId, GLOBAL_SCOPE) as unknown as FactRow[]
  if (!rows.length) return []
  const everything = db
    .prepare('SELECT text FROM facts WHERE forgotten_at IS NULL AND scope IN (?, ?)')
    .all(projectId, GLOBAL_SCOPE) as { text: string }[]
  const df = docFrequency(everything.map((r) => r.text))
  const picked = rows
    .filter((row) => strongMatch(asked, stems(row.text), df, everything.length))
    .slice(0, limit)
  markUsed(
    db,
    picked.map((r) => r.id)
  )
  return picked.map(toFact)
}

// ---- the conversation --------------------------------------------------------

export interface StoredMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  note: string | null
  /** ISO time, or '' for messages moved over from older chat logs. */
  createdAt: string
}

interface MessageRow {
  id: number
  role: string
  text: string
  note: string | null
  created_at: string
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    role: row.role as StoredMessage['role'],
    text: row.text,
    note: row.note,
    createdAt: row.created_at
  }
}

const MESSAGE_CHARS = 8000

export function addMessage(
  db: DatabaseSync,
  projectId: string,
  role: StoredMessage['role'],
  text: string,
  note?: string | null,
  createdAt: string = now()
): void {
  const clean = text.trim()
  if (!clean) return
  db.prepare('INSERT INTO messages (project_id, role, text, note, created_at) VALUES (?, ?, ?, ?, ?)').run(
    projectId,
    role,
    clean.slice(0, MESSAGE_CHARS),
    note?.slice(0, 1000) ?? null,
    createdAt
  )
}

export function searchMessages(db: DatabaseSync, projectId: string, text: string, limit = 8): StoredMessage[] {
  const match = ftsQuery(text)
  if (!match) return []
  const rows = db
    .prepare(
      `SELECT messages.* FROM messages_fts JOIN messages ON messages.id = messages_fts.rowid
       WHERE messages_fts MATCH ? AND messages.project_id = ?
       ORDER BY bm25(messages_fts) LIMIT ?`
    )
    .all(match, projectId, limit) as unknown as MessageRow[]
  // Newest last, as in a conversation.
  return rows.map(toMessage).sort((a, b) => a.id - b.id)
}

export function recentMessages(db: DatabaseSync, projectId: string, limit = 8): StoredMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .all(projectId, limit) as unknown as MessageRow[]
  return rows.map(toMessage).reverse()
}

export function countMessages(db: DatabaseSync, projectId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE project_id = ?').get(projectId) as { n: number }).n
}

// ---- hand-offs ---------------------------------------------------------------

export interface Handoff {
  id: number
  agent: string
  brief: string
  request: string | null
  report: string | null
  status: 'running' | 'done' | 'error' | 'stopped'
  files: string[] | null
  startedAt: string
  finishedAt: string | null
}

interface HandoffRow {
  id: number
  agent: string
  brief: string
  request: string | null
  report: string | null
  status: string
  files: string | null
  started_at: string
  finished_at: string | null
}

function toHandoff(row: HandoffRow): Handoff {
  let files: string[] | null = null
  try {
    files = row.files ? (JSON.parse(row.files) as string[]) : null
  } catch {
    files = null
  }
  return {
    id: row.id,
    agent: row.agent,
    brief: row.brief,
    request: row.request,
    report: row.report,
    status: row.status as Handoff['status'],
    files,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }
}

export function startHandoff(
  db: DatabaseSync,
  projectId: string,
  agent: string,
  brief: string,
  request: string | null
): number {
  const result = db
    .prepare('INSERT INTO handoffs (project_id, agent, brief, request, started_at) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, agent, brief.slice(0, 6000), request?.slice(0, 2000) ?? null, now())
  return Number(result.lastInsertRowid)
}

export function finishHandoff(
  db: DatabaseSync,
  id: number,
  result: { status: Handoff['status']; report: string; files: string[] | null }
): void {
  db.prepare('UPDATE handoffs SET status = ?, report = ?, files = ?, finished_at = ? WHERE id = ?').run(
    result.status,
    result.report.slice(0, 12000),
    result.files ? JSON.stringify(result.files.slice(0, 200)) : null,
    now(),
    id
  )
}

export function recentHandoffs(db: DatabaseSync, projectId: string, limit = 3): Handoff[] {
  const rows = db
    .prepare("SELECT * FROM handoffs WHERE project_id = ? AND status != 'running' ORDER BY id DESC LIMIT ?")
    .all(projectId, limit) as unknown as HandoffRow[]
  return rows.map(toHandoff).reverse()
}

export function getHandoff(db: DatabaseSync, projectId: string, id: number): Handoff | null {
  const row = db.prepare('SELECT * FROM handoffs WHERE id = ? AND project_id = ?').get(id, projectId) as
    | HandoffRow
    | undefined
  return row ? toHandoff(row) : null
}

/** A run left "running" by a crash or quit is closed off at startup. */
export function closeStaleHandoffs(db: DatabaseSync): void {
  db.prepare(
    "UPDATE handoffs SET status = 'stopped', report = 'Interrupted before it finished.', finished_at = ? WHERE status = 'running'"
  ).run(now())
}

// ---- code map -----------------------------------------------------------------

export interface CodeFile {
  path: string
  summary: string
  hash: string
}

export function hashFile(fullPath: string): string | null {
  try {
    if (statSync(fullPath).size > 400_000) return null
    return createHash('sha1').update(readFileSync(fullPath)).digest('hex')
  } catch {
    return null
  }
}

export function codeHashes(db: DatabaseSync, projectId: string): Map<string, string> {
  const rows = db.prepare('SELECT path, hash FROM code_files WHERE project_id = ?').all(projectId) as {
    path: string
    hash: string
  }[]
  return new Map(rows.map((r) => [r.path, r.hash]))
}

export function saveCodeSummaries(db: DatabaseSync, projectId: string, files: CodeFile[]): void {
  const stmt = db.prepare(
    `INSERT INTO code_files (project_id, path, summary, hash, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, path) DO UPDATE SET summary = excluded.summary, hash = excluded.hash, updated_at = excluded.updated_at`
  )
  const at = now()
  transaction(db, () => {
    for (const f of files) stmt.run(projectId, f.path, f.summary.slice(0, 240), f.hash, at)
  })
}

export function removeCodeFiles(db: DatabaseSync, projectId: string, paths: string[]): void {
  const stmt = db.prepare('DELETE FROM code_files WHERE project_id = ? AND path = ?')
  transaction(db, () => {
    for (const p of paths) stmt.run(projectId, p)
  })
}

/** One-line descriptions of the given files from the code map (files not mapped are left out). */
export function codeSummariesFor(db: DatabaseSync, projectId: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const stmt = db.prepare('SELECT summary FROM code_files WHERE project_id = ? AND path = ?')
  for (const path of paths) {
    const row = stmt.get(projectId, path) as { summary: string } | undefined
    if (row?.summary) out.set(path, row.summary)
  }
  return out
}

/**
 * Remembered conventions and decisions that bear on a change: related
 * preferences, gotchas and decisions that aren't already among the key facts
 * every request starts with.
 */
export function reviewConventions(db: DatabaseSync, projectId: string, text: string, limit = 4): MemoryFact[] {
  return relevantFacts(db, projectId, text, 10)
    .filter((f) => f.category === 'preference' || f.category === 'gotcha' || f.category === 'decision')
    .slice(0, limit)
}

/** The first `limit` mapped files, by path, with their one-line descriptions. */
export function listCodeFiles(db: DatabaseSync, projectId: string, limit = 60): { path: string; summary: string }[] {
  return db
    .prepare('SELECT path, summary FROM code_files WHERE project_id = ? ORDER BY path LIMIT ?')
    .all(projectId, limit) as unknown as { path: string; summary: string }[]
}

export function countCodeFiles(db: DatabaseSync, projectId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM code_files WHERE project_id = ?').get(projectId) as { n: number }).n
}

export function searchCode(db: DatabaseSync, projectId: string, text: string, limit = 8): CodeFile[] {
  const match = ftsQuery(text)
  if (!match) return []
  return db
    .prepare(
      `SELECT code_files.path, code_files.summary, code_files.hash FROM code_fts
       JOIN code_files ON code_files.id = code_fts.rowid
       WHERE code_fts MATCH ? AND code_files.project_id = ? ORDER BY bm25(code_fts) LIMIT ?`
    )
    .all(match, projectId, limit) as unknown as CodeFile[]
}

/** Files from a search that really relate to the request (same bar as relevantFacts). */
export function relevantCode(db: DatabaseSync, projectId: string, text: string, limit = 5): CodeFile[] {
  const asked = new Set(stems(text))
  const candidates = searchCode(db, projectId, text, 15)
  if (!candidates.length) return []
  const describe = (f: { path: string; summary: string }): string => `${f.path.replace(/[\\/._-]+/g, ' ')} ${f.summary}`
  const everything = db
    .prepare('SELECT path, summary FROM code_files WHERE project_id = ?')
    .all(projectId) as { path: string; summary: string }[]
  const df = docFrequency(everything.map(describe))
  return candidates
    .filter((f) => strongMatch(asked, stems(describe(f)), df, everything.length))
    .slice(0, limit)
}

// ---- erasing a project ----------------------------------------------------------

/** Removes everything the database holds for one project. Returns what was removed. */
export function eraseProjectFromMemory(
  db: DatabaseSync,
  projectId: string
): { facts: number; messages: number; handoffs: number; files: number } {
  return transaction(db, () => {
    // The search index for messages has no delete trigger, so clear it row by row.
    const rows = db
      .prepare('SELECT id, text, note FROM messages WHERE project_id = ?')
      .all(projectId) as { id: number; text: string; note: string | null }[]
    const unindex = db.prepare("INSERT INTO messages_fts(messages_fts, rowid, text, note) VALUES ('delete', ?, ?, ?)")
    for (const r of rows) unindex.run(r.id, r.text, r.note)

    const count = (sql: string): number => Number(db.prepare(sql).run(projectId).changes)
    const messages = count('DELETE FROM messages WHERE project_id = ?')
    const facts = count('DELETE FROM facts WHERE scope = ?')
    const handoffs = count('DELETE FROM handoffs WHERE project_id = ?')
    const files = count('DELETE FROM code_files WHERE project_id = ?')
    count('DELETE FROM usage_log WHERE project_id = ?')
    count('DELETE FROM request_log WHERE project_id = ?')
    count('DELETE FROM todos WHERE project_id = ?')
    count('DELETE FROM notes WHERE project_id = ?')
    db.prepare('DELETE FROM meta WHERE key IN (?, ?, ?)').run(
      `history_imported:${projectId}`,
      `tidy:${projectId}`,
      `catchup:${projectId}`
    )
    return { facts, messages, handoffs, files }
  })
}

// ---- the user's to-do list and notes -------------------------------------------------

/** Longest to-do (one line) and notes (a page or two) kept. */
export const TODO_MAX_CHARS = 300
export const NOTES_MAX_CHARS = 50_000

interface TodoRow {
  id: string
  text: string
  done: number
  source: string
  created_at: string
  done_at: string | null
}

function toTodo(row: TodoRow): TodoItem {
  return {
    id: row.id,
    text: row.text,
    done: row.done === 1,
    source: row.source === 'claude' || row.source === 'codex' ? row.source : 'user',
    createdAt: row.created_at,
    doneAt: row.done_at
  }
}

/** Open items in the user's order, then finished ones (newest first). */
export function listTodos(db: DatabaseSync, projectId: string): TodoItem[] {
  const rows = db
    .prepare(
      'SELECT id, text, done, source, created_at, done_at FROM todos WHERE project_id = ? ORDER BY done, CASE WHEN done = 1 THEN done_at END DESC, position'
    )
    .all(projectId) as unknown as TodoRow[]
  return rows.map(toTodo)
}

function oneLineTodo(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, TODO_MAX_CHARS)
}

/**
 * Adds a to-do at the end (or the top). An open item with the same words
 * isn't added twice: the agents may report the same leftover more than once.
 */
export function addTodo(
  db: DatabaseSync,
  projectId: string,
  text: string,
  source: string,
  opts: { top?: boolean } = {}
): { todo: TodoItem; duplicate: boolean } {
  const clean = oneLineTodo(text)
  if (!clean) throw new Error('A to-do needs some text.')
  const open = listTodos(db, projectId).filter((t) => !t.done)
  const same = open.find((t) => t.text.toLowerCase() === clean.toLowerCase() || similarity(t.text, clean) >= 0.85)
  if (same) return { todo: same, duplicate: true }
  const edge = db
    .prepare(`SELECT ${opts.top ? 'MIN' : 'MAX'}(position) AS p FROM todos WHERE project_id = ? AND done = 0`)
    .get(projectId) as { p: number | null }
  const position = edge.p === null ? 0 : opts.top ? edge.p - 1 : edge.p + 1
  const id = newId()
  const at = now()
  db.prepare(
    'INSERT INTO todos (id, project_id, text, done, position, source, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)'
  ).run(id, projectId, clean, position, source === 'claude' || source === 'codex' ? source : 'user', at, at)
  return { todo: listTodos(db, projectId).find((t) => t.id === id) as TodoItem, duplicate: false }
}

/** Changes a to-do's text or ticks it on/off. Returns null if it isn't in this project. */
export function updateTodo(
  db: DatabaseSync,
  projectId: string,
  id: string,
  patch: { text?: string; done?: boolean }
): TodoItem | null {
  const row = db.prepare('SELECT id, done FROM todos WHERE id = ? AND project_id = ?').get(id, projectId) as
    | { id: string; done: number }
    | undefined
  if (!row) return null
  const at = now()
  if (patch.text !== undefined) {
    const clean = oneLineTodo(patch.text)
    if (!clean) throw new Error('A to-do needs some text.')
    db.prepare('UPDATE todos SET text = ?, updated_at = ? WHERE id = ?').run(clean, at, id)
  }
  if (patch.done !== undefined && patch.done !== (row.done === 1)) {
    // Un-ticking puts it back at the end of the open list.
    const end = db.prepare('SELECT MAX(position) AS p FROM todos WHERE project_id = ? AND done = 0').get(projectId) as { p: number | null }
    db.prepare('UPDATE todos SET done = ?, done_at = ?, position = ?, updated_at = ? WHERE id = ?').run(
      patch.done ? 1 : 0,
      patch.done ? at : null,
      patch.done ? 0 : (end.p ?? 0) + 1,
      at,
      id
    )
  }
  return listTodos(db, projectId).find((t) => t.id === id) ?? null
}

export function deleteTodo(db: DatabaseSync, projectId: string, id: string): boolean {
  return Number(db.prepare('DELETE FROM todos WHERE id = ? AND project_id = ?').run(id, projectId).changes) > 0
}

/** Clears the finished items. */
export function clearDoneTodos(db: DatabaseSync, projectId: string): number {
  return Number(db.prepare('DELETE FROM todos WHERE project_id = ? AND done = 1').run(projectId).changes)
}

/** Puts the open items in this order (ids not listed keep their place after them). */
export function reorderTodos(db: DatabaseSync, projectId: string, ids: string[]): void {
  transaction(db, () => {
    const set = db.prepare('UPDATE todos SET position = ?, updated_at = ? WHERE id = ? AND project_id = ? AND done = 0')
    const at = now()
    ids.forEach((id, i) => set.run(i, at, id, projectId))
    const rest = db
      .prepare(`SELECT id FROM todos WHERE project_id = ? AND done = 0 AND id NOT IN (${ids.map(() => '?').join(',') || "''"}) ORDER BY position`)
      .all(projectId, ...ids) as { id: string }[]
    rest.forEach((r, i) => set.run(ids.length + i, at, r.id, projectId))
  })
}

export function getNotes(db: DatabaseSync, projectId: string): { text: string; updatedAt: string | null } {
  const row = db.prepare('SELECT text, updated_at FROM notes WHERE project_id = ?').get(projectId) as
    | { text: string; updated_at: string }
    | undefined
  return { text: row?.text ?? '', updatedAt: row?.updated_at ?? null }
}

export function setNotes(db: DatabaseSync, projectId: string, text: string): string {
  const at = now()
  db.prepare(
    'INSERT INTO notes (project_id, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at'
  ).run(projectId, text.slice(0, NOTES_MAX_CHARS), at)
  return at
}

/** Changes whenever any project's to-dos change (including from an agent's own process). */
export function todosSignature(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare('SELECT project_id, COUNT(*) AS n, MAX(updated_at) AS at FROM todos GROUP BY project_id')
    .all() as { project_id: string; n: number; at: string }[]
  return new Map(rows.map((r) => [r.project_id, `${r.n}:${r.at}`]))
}

// ---- usage log ---------------------------------------------------------------

export type UsageKind =
  | 'request' // Claude working on the user's request
  | 'handoff' // Codex doing a hand-off
  | 'review' // Codex reviewing Claude's change
  | 'route' // Haiku judging the request
  | 'scribe' // Haiku saving memory
  | 'tidy' // Haiku tidying memory
  | 'codemap' // Haiku summarising files
  | 'summary' // Haiku summarising a conversation for a fresh session
  | 'takeover' // Codex handling a request directly because Claude was out
  | 'chat' // a question answered without building (Ask mode or the Chat tab)
  | 'brief' // Haiku writing the project brief
  | 'compact' // Claude compacting a long conversation (estimated: the SDK doesn't report it)
// (A background job's agent is "claude" when Haiku did it, "cline" when Cline did.)

export interface UsageRecord {
  projectId?: string
  kind: UsageKind
  agent: 'claude' | 'codex' | 'cline'
  model?: string
  /** Tokens that were newly processed (not served from the cache), input side. */
  fresh: number
  /** Input tokens served from the prompt cache. */
  cached: number
  output: number
  steps?: number
  costUsd?: number
}

export function logUsage(db: DatabaseSync, record: UsageRecord): void {
  db.prepare(
    `INSERT INTO usage_log (at, project_id, kind, agent, model, fresh, cached, output, steps, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    now(),
    record.projectId ?? '',
    record.kind,
    record.agent,
    record.model ?? null,
    Math.round(record.fresh),
    Math.round(record.cached),
    Math.round(record.output),
    record.steps ?? 1,
    record.costUsd ?? null
  )
}

/** Totals by kind of work since a time, for the Settings screen. */
export function usageSummary(
  db: DatabaseSync,
  sinceIso: string,
  projectId?: string
): { kind: string; runs: number; fresh: number; cached: number; output: number }[] {
  return db
    .prepare(
      `SELECT kind || ' (' || agent || ')' AS kind, COUNT(*) AS runs, SUM(fresh) AS fresh,
              SUM(cached) AS cached, SUM(output) AS output
       FROM usage_log WHERE at >= ? ${projectId ? 'AND project_id = ?' : ''}
       GROUP BY kind, agent ORDER BY fresh + output DESC`
    )
    .all(...(projectId ? [sinceIso, projectId] : [sinceIso])) as {
    kind: string
    runs: number
    fresh: number
    cached: number
    output: number
  }[]
}

/** Totals by project and agent since a time (for the usage report). */
export function usageByProject(
  db: DatabaseSync,
  sinceIso: string
): { projectId: string; agent: string; kind: string; model: string | null; runs: number; fresh: number; cached: number; output: number }[] {
  return db
    .prepare(
      `SELECT project_id AS projectId, agent, kind, model, COUNT(*) AS runs, SUM(fresh) AS fresh,
              SUM(cached) AS cached, SUM(output) AS output
       FROM usage_log WHERE at >= ? GROUP BY project_id, agent, kind, model`
    )
    .all(sinceIso) as { projectId: string; agent: string; kind: string; model: string | null; runs: number; fresh: number; cached: number; output: number }[]
}

/** Codex tokens for one project since a time (a request's hand-offs, for its request_log row). */
export function codexUsageSince(db: DatabaseSync, projectId: string, sinceIso: string): { fresh: number; cached: number; output: number } {
  return agentUsageSince(db, projectId, sinceIso, 'codex')
}

/** One agent's tokens for one project since a time (Cline: its hand-offs only, not background jobs). */
export function agentUsageSince(
  db: DatabaseSync,
  projectId: string,
  sinceIso: string,
  agent: 'codex' | 'cline'
): { fresh: number; cached: number; output: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(fresh), 0) AS fresh, COALESCE(SUM(cached), 0) AS cached, COALESCE(SUM(output), 0) AS output
       FROM usage_log WHERE project_id = ? AND agent = ? AND at >= ? ${agent === 'cline' ? "AND kind = 'handoff'" : ''}`
    )
    .get(projectId, agent, sinceIso) as { fresh: number; cached: number; output: number }
  return { fresh: Number(row.fresh), cached: Number(row.cached), output: Number(row.output) }
}

export interface RequestLogRow {
  at: string
  projectId: string
  /** build, plan (making one), plan_build (building an approved one), takeover (Codex alone). */
  mode: string
  balance: string | null
  route: string | null
  size: string | null
  model: string | null
  text: string
  /** done, stopped or error. */
  outcome: string
  seconds: number
  /** Claude's model calls (each re-reads the conversation). */
  claudeSteps: number
  /** Claude's own tool calls by kind (see stepKind). */
  tools: Record<string, number>
  handoffs: number
  claude: { fresh: number; cached: number; output: number }
  codex: { fresh: number; cached: number; output: number }
  cline: { fresh: number; cached: number; output: number }
}

export function logRequest(db: DatabaseSync, row: RequestLogRow): void {
  db.prepare(
    `INSERT INTO request_log (at, project_id, mode, balance, route, size, model, text, outcome, seconds, claude_steps, tools, handoffs,
       claude_fresh, claude_cached, claude_output, codex_fresh, codex_cached, codex_output, cline_fresh, cline_cached, cline_output)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.at,
    row.projectId,
    row.mode,
    row.balance,
    row.route,
    row.size,
    row.model,
    row.text.slice(0, 300),
    row.outcome,
    Math.round(row.seconds),
    row.claudeSteps,
    JSON.stringify(row.tools),
    row.handoffs,
    Math.round(row.claude.fresh),
    Math.round(row.claude.cached),
    Math.round(row.claude.output),
    Math.round(row.codex.fresh),
    Math.round(row.codex.cached),
    Math.round(row.codex.output),
    Math.round(row.cline.fresh),
    Math.round(row.cline.cached),
    Math.round(row.cline.output)
  )
}

export function listRequests(db: DatabaseSync, sinceIso: string, projectId?: string): RequestLogRow[] {
  const rows = db
    .prepare(`SELECT * FROM request_log WHERE at >= ? ${projectId ? 'AND project_id = ?' : ''} ORDER BY at`)
    .all(...(projectId ? [sinceIso, projectId] : [sinceIso])) as Record<string, unknown>[]
  return rows.map((r) => {
    let tools: Record<string, number> = {}
    try {
      tools = JSON.parse(String(r.tools ?? '{}'))
    } catch {
      // an unreadable row just has no breakdown
    }
    return {
      at: String(r.at),
      projectId: String(r.project_id),
      mode: String(r.mode),
      balance: (r.balance as string | null) ?? null,
      route: (r.route as string | null) ?? null,
      size: (r.size as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      text: String(r.text ?? ''),
      outcome: String(r.outcome),
      seconds: Number(r.seconds),
      claudeSteps: Number(r.claude_steps),
      tools,
      handoffs: Number(r.handoffs),
      claude: { fresh: Number(r.claude_fresh), cached: Number(r.claude_cached), output: Number(r.claude_output) },
      codex: { fresh: Number(r.codex_fresh), cached: Number(r.codex_cached), output: Number(r.codex_output) },
      cline: { fresh: Number(r.cline_fresh ?? 0), cached: Number(r.cline_cached ?? 0), output: Number(r.cline_output ?? 0) }
    }
  })
}

// ---- deciding what counts as relevant -------------------------------------------

/** Crude plural/verb folding, for comparing words ("enemies" ~ "enemy", "sprites" ~ "sprite"). */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && /(sses|xes|ches|shes)$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

function stems(text: string): string[] {
  return words(text).map(stem)
}

/** In how many of these texts each word appears. */
function docFrequency(texts: string[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const t of texts) for (const w of new Set(stems(t))) df.set(w, (df.get(w) ?? 0) + 1)
  return df
}

/**
 * Whether an item really relates to the request: it shares two meaningful
 * words, or one that's distinctive here (rare among this project's own
 * facts or files) -- "slime" counts, "game" doesn't. A one- or two-word
 * request is taken at its word.
 */
function strongMatch(asked: Set<string>, item: string[], df: Map<string, number>, total: number): boolean {
  const shared = [...new Set(item)].filter((w) => asked.has(w))
  if (shared.length >= 2) return true
  if (shared.length === 1 && asked.size <= 2) return true
  const rareLimit = Math.max(2, Math.floor(total * 0.15))
  return shared.some((w) => w.length >= 4 && (df.get(w) ?? 0) <= rareLimit)
}
