import { execFile } from 'child_process'
import { readFileSync, statSync } from 'fs'
import { extname, join } from 'path'
import { promisify } from 'util'
import { getSettings } from '../settings/store'
import { helpersAllowed, runHelperJob, type JsonSchema } from '../helpers/helperJob'
import { memoryDb } from './paths'
import { codeHashes, countCodeFiles, hashFile, removeCodeFiles, saveCodeSummaries, type CodeFile } from './store'

const execFileAsync = promisify(execFile)

// A one-line summary per source file, written in the background (Cline or Haiku) and refreshed only
// for files whose content changed. It's what lets an agent answer "which
// file handles X?" with one search instead of exploring the project.

const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte', '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.php', '.swift', '.lua',
  '.sh', '.ps1', '.bat', '.sql', '.md', '.yml', '.yaml', '.toml', '.json'
])
const SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|node_modules|dist|build|out|\.git)\//i
const SKIP_NAMES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|AGENTS\.md)$|\.min\.(js|css)$|\.map$/i
/** Plain data files are listed only when small; big ones are data, not code. */
const DATA_EXTENSIONS = new Set(['.json', '.md', '.yml', '.yaml', '.toml', '.sql'])

const MAX_FILES = 600
const PER_RUN = 80
const BATCH = 20
const HEAD_CHARS = 1200
const MIN_GAP_MS = 30_000

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, summary: { type: 'string' } },
        required: ['path', 'summary'],
        additionalProperties: false
      }
    }
  },
  required: ['files'],
  additionalProperties: false
}

async function listFiles(projectPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: projectPath,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
  const files: string[] = []
  for (const raw of stdout.split('\0').filter(Boolean)) {
    const rel = raw.replace(/\\/g, '/')
    const ext = extname(rel).toLowerCase()
    if (!SOURCE_EXTENSIONS.has(ext) || SKIP.test(rel) || SKIP_NAMES.test(rel)) continue
    try {
      const size = statSync(join(projectPath, rel)).size
      if (size === 0 || size > (DATA_EXTENSIONS.has(ext) ? 30_000 : 150_000)) continue
    } catch {
      continue
    }
    files.push(rel)
  }
  return files.sort().slice(0, MAX_FILES)
}

async function summarize(projectId: string, entries: { path: string; head: string }[]): Promise<Map<string, string>> {
  const prompt = `Below are source files from a software project (the start of each). For every file, write one plain sentence of at most 14 words saying what it is for or contains, concrete enough that someone searching for a feature would find it ("Player movement, collision with walls and enemies", not "Game logic"). Return every path exactly as given.

${entries.map((e) => `### ${e.path}\n${e.head}`).join('\n\n')}`
  const answer = await runHelperJob({ kind: 'codemap', projectId, prompt, schema: SCHEMA })
  const out = new Map<string, string>()
  for (const f of (answer.structured as { files: { path: string; summary: string }[] }).files) {
    if (f.path && f.summary?.trim()) out.set(f.path.replace(/\\/g, '/'), f.summary.trim())
  }
  return out
}

export interface CodeMapResult {
  summarized: number
  removed: number
  /** Changed files still waiting for a later run. */
  pending: number
}

const running = new Set<string>()
const lastRun = new Map<string, number>()

/** Brings a project's code map up to date: new and changed files summarised, deleted ones dropped. */
export async function refreshCodeMap(projectId: string, projectPath: string, perRun = PER_RUN): Promise<CodeMapResult> {
  if (running.has(projectId)) return { summarized: 0, removed: 0, pending: 0 }
  running.add(projectId)
  try {
    const db = memoryDb()
    const files = await listFiles(projectPath)
    const stored = codeHashes(db, projectId)
    const current = new Map<string, string>()
    for (const rel of files) {
      const hash = hashFile(join(projectPath, rel))
      if (hash) current.set(rel, hash)
    }

    const removed = [...stored.keys()].filter((p) => !current.has(p))
    if (removed.length) removeCodeFiles(db, projectId, removed)

    // New files first, then changed ones.
    const todo = [...current.keys()]
      .filter((p) => stored.get(p) !== current.get(p))
      .sort((a, b) => Number(stored.has(a)) - Number(stored.has(b)) || a.localeCompare(b))
    const batch = todo.slice(0, perRun)

    let summarized = 0
    for (let start = 0; start < batch.length; start += BATCH) {
      const group = batch.slice(start, start + BATCH)
      const entries = group.map((path) => {
        let head = ''
        try {
          head = readFileSync(join(projectPath, path), 'utf-8').slice(0, HEAD_CHARS)
        } catch {
          head = ''
        }
        return { path, head }
      })
      const summaries = await summarize(projectId, entries)
      const saved: CodeFile[] = group.map((path) => ({
        path,
        // A file Haiku skipped still gets an entry, so it isn't retried every run.
        summary: summaries.get(path) ?? `${extname(path).slice(1).toUpperCase() || 'Text'} file`,
        hash: current.get(path)!
      }))
      saveCodeSummaries(db, projectId, saved)
      summarized += saved.length
    }
    return { summarized, removed: removed.length, pending: Math.max(0, todo.length - batch.length) }
  } finally {
    running.delete(projectId)
    lastRun.set(projectId, Date.now())
  }
}

/** Refreshes in the background if the setting is on and it hasn't just run. Never throws. */
export function maybeRefreshCodeMap(projectId: string, projectPath: string): void {
  try {
    if (!getSettings().codeMap || running.has(projectId)) return
    if (Date.now() - (lastRun.get(projectId) ?? 0) < MIN_GAP_MS) return
    helpersAllowed()
      .then((allowed) => (allowed ? refreshCodeMap(projectId, projectPath) : { summarized: 0, removed: 0, pending: 0 }))
      .then((r) => {
        // A big project is mapped over several runs.
        if (r.pending > 0) setTimeout(() => maybeRefreshCodeMap(projectId, projectPath), MIN_GAP_MS)
      })
      .catch((err) => console.warn('Code map refresh failed:', (err as Error).message))
  } catch (err) {
    console.warn('Code map check failed:', (err as Error).message)
  }
}

export function codeMapSize(projectId: string): number {
  try {
    return countCodeFiles(memoryDb(), projectId)
  } catch {
    return 0
  }
}
