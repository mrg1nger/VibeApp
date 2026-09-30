import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MEMORY_CATEGORIES, type MemoryFact, type MemoryTidyResult } from '@shared/types'
import { resolveClaudeExecutable } from '../cli/claudeBinary'
import { memoryDb } from './paths'
import {
  countFacts,
  defaultKey,
  forgetFact,
  getMeta,
  listFacts,
  normalizeCategory,
  setMeta,
  transaction
} from './store'

/** Facts per Haiku request; larger scopes are tidied in several batches. */
const BATCH = 120
/** Past this many facts, tidy daily or after every 20 new ones. */
const TIDY_ABOVE = 50
const TIDY_EVERY_MS = 24 * 60 * 60 * 1000
const TIDY_AFTER_NEW = 20

const TIDY_SCHEMA = {
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
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id', 'reason'],
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
  outdated: { id: string; reason: string }[]
}

function prompt(facts: MemoryFact[], unclassified: Set<string>): string {
  const lines = facts.map((f) =>
    JSON.stringify({
      id: f.id,
      text: f.text,
      ...(unclassified.has(f.id) ? { needsCategory: true } : { category: f.category, key: f.key }),
      saved: f.createdAt.slice(0, 10),
      timesUsed: f.useCount
    })
  )
  return `These are facts an AI coding assistant remembered about a software project (or about the user, across projects). Tidy them up.

1. facts: for every fact marked needsCategory, give a category and key.
   Categories: about = what the project is or contains; setup = how to run, build, test or deploy; decision = a choice made and why; preference = how the user likes things done; gotcha = a non-obvious pitfall; other.
   key = true only for facts needed on almost every request (what the project is, how to run it, the user's standing preferences). Aim for at most about 15 key facts overall.
2. merges: groups of facts that say the same thing. Keep one (keep), list the others (remove), and give the best combined wording (text), keeping every useful detail.
3. outdated: facts that a NEWER fact clearly contradicts or replaces (e.g. an old run command after a switch to a new one). Only when it is clear; when in doubt, leave it.

Never invent facts. Use only the ids given. Facts:
${lines.join('\n')}`
}

async function planBatch(facts: MemoryFact[], unclassified: Set<string>): Promise<TidyPlan> {
  const session = query({
    prompt: prompt(facts, unclassified),
    options: {
      cwd: mkdtempSync(join(tmpdir(), 'vibeapp-tidy-')),
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      model: 'haiku',
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      settings: { disableClaudeAiConnectors: true },
      maxTurns: 3,
      outputFormat: { type: 'json_schema', schema: TIDY_SCHEMA }
    }
  })
  for await (const message of session) {
    if (message.type !== 'result') continue
    if (message.subtype !== 'success' || !message.structured_output) {
      throw new Error(`Memory tidy-up failed (${message.subtype}).`)
    }
    return message.structured_output as TidyPlan
  }
  throw new Error('Memory tidy-up ended without a result.')
}

const running = new Set<string>()

/** Tidies one scope (a project id, or "global") now. */
export async function tidyMemory(scope: string): Promise<MemoryTidyResult> {
  if (running.has(scope)) throw new Error('A tidy-up is already running for this memory.')
  running.add(scope)
  const result: MemoryTidyResult = { categorized: 0, merged: 0, outdated: 0 }
  try {
    const db = memoryDb()
    const all = listFacts(db, scope)
    for (let start = 0; start < all.length; start += BATCH) {
      const batch = all.slice(start, start + BATCH)
      const unclassifiedRows = db
        .prepare(`SELECT id FROM facts WHERE scope = ? AND classified = 0 AND forgotten_at IS NULL`)
        .all(scope) as { id: string }[]
      const unclassified = new Set(unclassifiedRows.map((r) => r.id).filter((id) => batch.some((f) => f.id === id)))
      const plan = await planBatch(batch, unclassified)
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
            if (forgetFact(db, id, `tidy-up: merged into ${merge.keep}`)) {
              forgotten.add(id)
              result.merged++
            }
          }
        }
        for (const old of plan.outdated) {
          if (!inBatch.has(old.id) || forgotten.has(old.id)) continue
          if (forgetFact(db, old.id, `tidy-up: outdated (${old.reason})`)) {
            forgotten.add(old.id)
            result.outdated++
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
  try {
    const db = memoryDb()
    const { active, unclassified } = countFacts(db, scope)
    const last = JSON.parse(getMeta(db, `tidy:${scope}`) ?? 'null') as { at: number; count: number } | null
    const due =
      unclassified > 0 ||
      (active > TIDY_ABOVE && (!last || Date.now() - last.at > TIDY_EVERY_MS || active - last.count >= TIDY_AFTER_NEW))
    if (!due || running.has(scope)) return
    tidyMemory(scope).catch((err) => console.warn(`Memory tidy-up (${scope}) failed:`, (err as Error).message))
  } catch (err) {
    console.warn('Memory tidy-up check failed:', (err as Error).message)
  }
}
