import { readFileSync } from 'fs'
import { join } from 'path'
import { MEMORY_CATEGORIES, type MemoryFact, type MemoryTidyResult } from '@shared/types'
import { helpersAllowed, runHelperJob, type JsonSchema } from '../helpers/helperJob'
import { getProject } from '../projects/store'
import { memoryDb } from './paths'
import {
  codeSummariesFor,
  confirmFactFiles,
  countFacts,
  GLOBAL_SCOPE,
  defaultKey,
  forgetFact,
  getMeta,
  listFacts,
  normalizeCategory,
  setMeta,
  transaction,
  UNUSED_DAYS,
  unusedFacts
} from './store'
import type { DatabaseSync } from 'node:sqlite'

/** Facts per Haiku request; larger scopes are tidied in several batches. */
const BATCH = 120
/** Past this many facts, tidy daily or after every 20 new ones. */
const TIDY_ABOVE = 50
const TIDY_EVERY_MS = 24 * 60 * 60 * 1000
const TIDY_AFTER_NEW = 20
/** Facts that may be out of date are checked at most this often (they wait for the next tidy-up otherwise). */
const CHECK_OUTDATED_EVERY_MS = 6 * 60 * 60 * 1000
/** How much of each changed file the check is shown, and for how many files. */
const FILE_HEAD_CHARS = 1500
const FILES_SHOWN = 8

const TIDY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: { type: 'string', enum: [...MEMORY_CATEGORIES] },
          key: { type: 'boolean' }
        },
        required: ['id', 'category', 'key'],
        additionalProperties: false
      }
    },
    merges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keep: { type: 'string' },
          remove: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' }
        },
        required: ['keep', 'remove', 'text'],
        additionalProperties: false
      }
    },
    outdated: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
          replacedBy: { type: 'string', description: 'id of the newer fact that replaces it, or "" if none' }
        },
        required: ['id', 'reason', 'replacedBy'],
        additionalProperties: false
      }
    }
  },
  required: ['facts', 'merges', 'outdated'],
  additionalProperties: false
}

interface TidyPlan {
  facts: { id: string; category: string; key: boolean }[]
  merges: { keep: string; remove: string[]; text: string }[]
  outdated: { id: string; reason: string; replacedBy?: string }[]
}

/** What the check of a possibly out-of-date fact is shown about its files: their summary now, and how they start. */
function filesNow(scope: string, facts: MemoryFact[]): string {
  const paths = [...new Set(facts.flatMap((f) => f.files ?? []))].slice(0, FILES_SHOWN)
  if (!paths.length) return ''
  const projectPath = getProject(scope)?.path
  const summaries = codeSummariesFor(memoryDb(), scope, paths)
  const parts = paths.map((path) => {
    let whole = ''
    try {
      whole = projectPath ? readFileSync(join(projectPath, path), 'utf-8') : ''
    } catch {
      return `### ${path}\n(gone: this file no longer exists)`
    }
    const shown = whole.length > FILE_HEAD_CHARS ? ` - only the first ${FILE_HEAD_CHARS} of ${whole.length} characters` : ' - the whole file'
    return `### ${path}${summaries.get(path) ? ` (${summaries.get(path)})` : ''}${projectPath ? shown : ''}\n${whole.slice(0, FILE_HEAD_CHARS) || '(not shown)'}`
  })
  return `\n\nThe files those facts are about, as they are now:\n${parts.join('\n\n')}`
}

function prompt(scope: string, facts: MemoryFact[], unclassified: Set<string>): string {
  const lines = facts.map((f) =>
    JSON.stringify({
      id: f.id,
      text: f.text,
      ...(unclassified.has(f.id) ? { needsCategory: true } : { category: f.category, key: f.key }),
      saved: f.createdAt.slice(0, 10),
      timesUsed: f.useCount,
      ...(f.mayBeOutdated ? { mayBeOutdated: f.mayBeOutdated, files: f.files } : {})
    })
  )
  const checking = facts.filter((f) => f.mayBeOutdated)
  return `These are facts an AI coding assistant remembered about a software project (or about the user, across projects). Tidy them up.

1. facts: for every fact marked needsCategory, give a category and key.
   Categories: about = what the project is or contains; setup = how to run, build, test or deploy; decision = a choice made and why; preference = how the user likes things done; gotcha = a non-obvious pitfall; other.
   key = true only for facts needed on almost every request (what the project is, how to run it, the user's standing preferences). Aim for at most about 15 key facts overall.
2. merges: groups of facts that say the same thing. Keep one (keep), list the others (remove), and give the best combined wording (text), keeping every useful detail.
3. outdated: facts that a NEWER fact clearly contradicts or replaces (e.g. an old run command after a switch to a new one); give the newer fact's id in replacedBy. Only when it is clear; when in doubt, leave it.${
    checking.length
      ? `
4. Facts marked mayBeOutdated: the files they are about have changed a lot, or are gone, since they were saved. Check each against the files as they are now (below) and the other facts. If it is clearly no longer true (it is about a file marked gone, or the files now plainly say something different), list it in outdated (replacedBy "" unless a newer fact replaces it). If it is still true, or the files don't show either way, leave it: it is kept. Where only the start of a file is shown, something not in that part may still be further down.`
      : ''
  }

Never invent facts. Use only the ids given. Facts:
${lines.join('\n')}${checking.length ? filesNow(scope, checking) : ''}`
}

async function planBatch(scope: string, facts: MemoryFact[], unclassified: Set<string>): Promise<TidyPlan> {
  const answer = await runHelperJob({
    kind: 'tidy',
    projectId: scope === GLOBAL_SCOPE ? undefined : scope,
    prompt: prompt(scope, facts, unclassified),
    schema: TIDY_SCHEMA,
    thinking: true
  })
  return answer.structured as TidyPlan
}

/** Retires the project's facts nobody has looked up in a long time (see unusedFacts). No model involved. */
export function retireUnusedFacts(db: DatabaseSync, scope: string): number {
  if (scope === GLOBAL_SCOPE) return 0
  let retired = 0
  for (const f of unusedFacts(db, scope)) {
    if (forgetFact(db, f.id, `tidy-up: not looked up in over ${UNUSED_DAYS} days of use`)) retired++
  }
  return retired
}

const running = new Set<string>()

/** Tidies one scope (a project id, or "global") now. */
export async function tidyMemory(scope: string): Promise<MemoryTidyResult> {
  if (running.has(scope)) throw new Error('A tidy-up is already running for this memory.')
  running.add(scope)
  const result: MemoryTidyResult = { categorized: 0, merged: 0, outdated: 0, unused: 0, checked: 0 }
  try {
    const db = memoryDb()
    result.unused = retireUnusedFacts(db, scope)
    // The ones that may be out of date first, so they are checked in the first batch.
    const all = listFacts(db, scope).sort((a, b) => Number(!!b.mayBeOutdated) - Number(!!a.mayBeOutdated))
    for (let start = 0; start < all.length; start += BATCH) {
      const batch = all.slice(start, start + BATCH)
      const unclassifiedRows = db
        .prepare(`SELECT id FROM facts WHERE scope = ? AND classified = 0 AND forgotten_at IS NULL`)
        .all(scope) as { id: string }[]
      const unclassified = new Set(unclassifiedRows.map((r) => r.id).filter((id) => batch.some((f) => f.id === id)))
      const plan = await planBatch(scope, batch, unclassified)
      const inBatch = new Set(batch.map((f) => f.id))
      transaction(db, () => {
        const classify = db.prepare('UPDATE facts SET category = ?, key = ?, classified = 1 WHERE id = ? AND classified = 0')
        for (const f of plan.facts) {
          if (!unclassified.has(f.id)) continue
          classify.run(normalizeCategory(f.category), f.key ? 1 : 0, f.id)
          result.categorized++
          unclassified.delete(f.id)
        }
        // Anything Haiku skipped still gets a default, so it isn't retried forever.
        for (const id of unclassified) {
          classify.run('other', defaultKey('other') ? 1 : 0, id)
        }
        const forgotten = new Set<string>()
        for (const merge of plan.merges) {
          if (!inBatch.has(merge.keep) || forgotten.has(merge.keep)) continue
          const remove = merge.remove.filter((id) => id !== merge.keep && inBatch.has(id) && !forgotten.has(id))
          if (!remove.length) continue
          if (merge.text.trim()) {
            db.prepare('UPDATE facts SET text = ?, updated_at = ? WHERE id = ?').run(
              merge.text.trim().slice(0, 1000),
              new Date().toISOString(),
              merge.keep
            )
          }
          // The kept fact is key if any of the merged ones was.
          db.prepare(
            `UPDATE facts SET key = MAX(key, (SELECT MAX(key) FROM facts WHERE id IN (${remove.map(() => '?').join(',')}))) WHERE id = ?`
          ).run(...remove, merge.keep)
          for (const id of remove) {
            if (forgetFact(db, id, `tidy-up: merged into ${merge.keep}`, merge.keep)) {
              forgotten.add(id)
              result.merged++
            }
          }
        }
        for (const old of plan.outdated) {
          if (!inBatch.has(old.id) || forgotten.has(old.id)) continue
          const newer = old.replacedBy && inBatch.has(old.replacedBy) && !forgotten.has(old.replacedBy) ? old.replacedBy : undefined
          if (forgetFact(db, old.id, `tidy-up: outdated (${old.reason})`, newer)) {
            forgotten.add(old.id)
            result.outdated++
          }
        }
        // Checked and kept: they count as up to date again.
        for (const f of batch) {
          if (f.mayBeOutdated && !forgotten.has(f.id)) {
            confirmFactFiles(db, f.id)
            result.checked++
          }
        }
      })
    }
    setMeta(db, `tidy:${scope}`, JSON.stringify({ at: Date.now(), count: countFacts(db, scope).active }))
    return result
  } finally {
    running.delete(scope)
  }
}

/** Starts a background tidy-up if this scope needs one. Never throws. */
export function maybeTidy(scope: string): void {
  helpersAllowed()
    .then((allowed) => {
      if (allowed) tidyIfDue(scope)
    })
    .catch((err) => console.warn('Memory tidy-up check failed:', (err as Error).message))
}

function tidyIfDue(scope: string): void {
  try {
    const db = memoryDb()
    // Needs no model, so it happens whether or not a tidy-up is due.
    if (!running.has(scope)) retireUnusedFacts(db, scope)
    const { active, unclassified } = countFacts(db, scope)
    const last = JSON.parse(getMeta(db, `tidy:${scope}`) ?? 'null') as { at: number; count: number } | null
    const sinceLast = last ? Date.now() - last.at : Infinity
    const due =
      unclassified > 0 ||
      (active > TIDY_ABOVE && (sinceLast > TIDY_EVERY_MS || !last || active - last.count >= TIDY_AFTER_NEW)) ||
      (sinceLast > CHECK_OUTDATED_EVERY_MS && listFacts(db, scope).some((f) => f.mayBeOutdated))
    if (!due || running.has(scope)) return
    tidyMemory(scope).catch((err) => console.warn(`Memory tidy-up (${scope}) failed:`, (err as Error).message))
  } catch (err) {
    console.warn('Memory tidy-up check failed:', (err as Error).message)
  }
}
