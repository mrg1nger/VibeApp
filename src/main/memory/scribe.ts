import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MEMORY_CATEGORIES, type MemoryCategory } from '@shared/types'
import { detectSecrets } from '@shared/secretPatterns'
import { resolveClaudeExecutable } from '../cli/claudeBinary'
import { countsFromSdkResult, recordUsage } from '../usage/tokens'
import { memoryDb } from './paths'
import { recentNotableCommands } from './commands'
import {
  forgetFact,
  getFact,
  GLOBAL_SCOPE,
  listFacts,
  recentHandoffs,
  recentMessages,
  rememberFact,
  searchFacts
} from './store'

// After each request, a cheap Haiku pass decides what (if anything) is worth
// remembering. Having Claude and Codex do it themselves cost each of them an
// extra step per request, and depended on them remembering to.

export interface TurnRecord {
  /** What the user asked, in their words. */
  request: string
  /** The assistant's replies during the request. */
  replies: string[]
  /** Short labels of what was done ("Edited src/player.js"). */
  actions: string[]
  stopped: boolean
  hadError: boolean
  /** Commands that were run (secrets already scrubbed), for saving how things are done. */
  commands?: string[]
  /** The last look before a fresh session: save everything a newcomer would need. */
  thorough?: boolean
}

export interface ScribeResult {
  added: number
  updated: number
  forgotten: number
}

const SCHEMA = {
  type: 'object',
  properties: {
    add: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          category: { type: 'string', enum: [...MEMORY_CATEGORIES] },
          key: { type: 'boolean' },
          global: { type: 'boolean' },
          // Forces a decision: a one-off instruction for this task isn't a preference.
          standing: {
            type: 'boolean',
            description:
              'true only if the user stated this as how things should generally be (always/never/I prefer), not as an instruction for this one task'
          }
        },
        required: ['text', 'category', 'key', 'global', 'standing'],
        additionalProperties: false
      }
    },
    update: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
        additionalProperties: false
      }
    },
    forget: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['add', 'update', 'forget'],
  additionalProperties: false
}

interface Plan {
  add: { text: string; category: MemoryCategory; key: boolean; global: boolean; standing: boolean }[]
  update: { id: string; text: string }[]
  forget: { id: string; reason: string }[]
}

const MAX_CHANGES = 3
const MAX_CHANGES_THOROUGH = 8

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function buildPrompt(turn: TurnRecord, known: string[]): string {
  const actions = turn.actions.length ? turn.actions.slice(-25).join('\n') : '(none)'
  const commands = turn.commands?.length ? turn.commands.slice(-25).join('\n') : ''
  const limit = turn.thorough ? MAX_CHANGES_THOROUGH : MAX_CHANGES
  const replies = turn.replies.map((r) => clip(r, 2500)).join('\n---\n') || '(no reply)'
  return `You keep the long-term memory of a software project that an AI coding assistant works on. After each exchange you decide what, if anything, is worth remembering for future sessions.

Worth remembering: what the project is; how to run, build, test or deploy it; decisions that were made and why; the user's standing preferences and rules; non-obvious pitfalls; naming and structure conventions that were agreed.
Not worth remembering: the task itself or its progress ("added a button"); things anyone can see in the code; temporary state; anything uncertain or guessed; anything already known; secrets, keys or passwords of any kind.

Procedures: if COMMANDS THAT WERE RUN show a multi-step routine that worked (a deploy, release, restart, backup, restore, migration, test run), save it as ONE fact in category "setup" that begins "Procedure - <name>:" and gives the commands in order exactly as run, plus what showed it succeeded (for example the check that came back fine). Use only commands that appear in that list, never invent steps, and refer to keys or passwords by their environment variable name, never their value. If a procedure with that name is already known, update it only when the working steps differ. A procedure fact can be up to 800 characters; mark it "key" only if it is under 300.
Be conservative: most exchanges produce nothing, so return empty lists. One standalone sentence per fact (a procedure is the exception).
Record only what the exchange actually says or clearly shows. Never add details that weren't stated (ports, versions, file names, commands), even if they would be typical. When correcting a known fact, state only what is now known to be true: drop details that belonged to the old version (an old port, path or option) unless the exchange confirms they still hold.
A preference or rule counts only if the USER said it and it plainly applies beyond this one task. What the assistant chose to do is not a preference of the user's. Instructions for this task alone ("keep it tiny", "just acknowledge", "no code changes") are not preferences. Don't save the same idea twice in different words, and save at most ${limit} facts.
Only mark a fact "key" if it is the project's description, how to run it, or a standing rule the user gave.
Prefer correcting a known fact (update, using its id) over adding one that contradicts it; use forget when a known fact is now plainly untrue. "global" is only for the user's preferences that apply to ALL their projects. "key" is only for facts needed on almost every request.

Known facts (id, category):
${known.length ? known.join('\n') : '(none yet)'}

The exchange:
USER: ${clip(turn.request, 3000)}
WHAT WAS DONE:
${actions}${commands ? `\nCOMMANDS THAT WERE RUN:\n${commands}` : ''}
ASSISTANT'S REPLY:
${replies}${turn.thorough ? '\n\nThis is the last look before the conversation moves to a fresh session that will not remember any of it. Be thorough: save every durable thing a newcomer would need that is not already known (procedures, services and where they run, standing rules, decisions and why, non-obvious pitfalls), up to the limit.' : ''}`
}

/**
 * A last, thorough look at the recent conversation and the commands that were
 * run, before the chat moves into a fresh session (which keeps only what is
 * saved). Returns what it saved.
 */
export function runSavePass(projectId: string): Promise<ScribeResult> {
  const messages = recentMessages(memoryDb(), projectId, 24)
  const users = messages.filter((m) => m.role === 'user').map((m) => clip(m.text, 600))
  const replies = messages.filter((m) => m.role !== 'user').map((m) => clip(m.text, 1200))
  return runScribe(projectId, {
    request: users.join('\n---\n'),
    replies: replies.slice(-10),
    actions: [],
    stopped: false,
    hadError: false,
    commands: recentNotableCommands(projectId, 25),
    thorough: true
  })
}

const chains = new Map<string, Promise<unknown>>()

/** Decides and saves what's worth remembering from one request. One run per project at a time. */
export function runScribe(projectId: string, turn: TurnRecord): Promise<ScribeResult> {
  const run = (chains.get(projectId) ?? Promise.resolve()).then(() => scribe(projectId, turn))
  chains.set(
    projectId,
    run.catch(() => undefined)
  )
  return run
}

async function scribe(projectId: string, turn: TurnRecord): Promise<ScribeResult> {
  const result: ScribeResult = { added: 0, updated: 0, forgotten: 0 }
  if (turn.stopped || turn.hadError || !turn.request.trim()) return result
  const db = memoryDb()

  // The facts it might need to correct: key facts plus whatever the exchange touches.
  const seen = new Map<string, string>()
  const consider = (id: string, category: string, text: string, scope: string): void => {
    seen.set(id, `- [${id}] (${category}${scope === GLOBAL_SCOPE ? ', all projects' : ''}) ${clip(text, 220)}`)
  }
  for (const f of listFacts(db, projectId)) if (f.key) consider(f.id, f.category, f.text, projectId)
  for (const f of listFacts(db, GLOBAL_SCOPE)) if (f.key) consider(f.id, f.category, f.text, GLOBAL_SCOPE)
  const topic = `${turn.request} ${turn.replies.join(' ')}`.slice(0, 1500)
  for (const f of searchFacts(db, projectId, topic, 15)) consider(f.id, f.category, f.text, projectId)

  const session = query({
    prompt: buildPrompt(turn, [...seen.values()].slice(0, 45)),
    options: {
      cwd: mkdtempSync(join(tmpdir(), 'vibeapp-scribe-')),
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      model: 'haiku',
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      settings: { disableClaudeAiConnectors: true },
      thinking: { type: 'disabled' },
      maxTurns: 3,
      outputFormat: { type: 'json_schema', schema: SCHEMA }
    }
  })
  let plan: Plan | undefined
  for await (const message of session) {
    if (message.type !== 'result') continue
    recordUsage(projectId, 'scribe', 'claude', countsFromSdkResult(message as Parameters<typeof countsFromSdkResult>[0]))
    if (message.subtype !== 'success' || !message.structured_output) {
      throw new Error(`Saving memory failed (${message.subtype}).`)
    }
    plan = message.structured_output as Plan
  }
  if (!plan) return result

  const mine = (id: string): boolean => {
    const row = db.prepare('SELECT scope FROM facts WHERE id = ?').get(id) as { scope: string } | undefined
    return !!row && (row.scope === projectId || row.scope === GLOBAL_SCOPE)
  }
  const safe = (text: string): boolean => text.trim().length > 0 && detectSecrets(text).length === 0

  // What this run has written so far, so it doesn't write the same thing twice.
  const written: string[] = []
  const evidence = [turn.request, ...turn.replies, ...turn.actions, ...(turn.commands ?? [])].join('\n')
  const maxChanges = turn.thorough ? MAX_CHANGES_THOROUGH : MAX_CHANGES

  for (const raw of plan.update.slice(0, maxChanges)) {
    const old = getFact(db, raw.id)
    const text = grounded(raw.text, evidence)
    const item = { ...raw, text: text ?? raw.text }
    if (!old || text === null || !safe(item.text) || !mine(item.id)) continue
    // Retire the old wording (restorable from the Memory screen) rather than
    // overwriting it, so an automatic correction can always be undone.
    const row = db.prepare('SELECT scope FROM facts WHERE id = ?').get(item.id) as { scope: string }
    if (!forgetFact(db, item.id, 'corrected automatically')) continue
    rememberFact(db, row.scope, item.text, 'scribe', { category: old.category, key: old.key })
    written.push(item.text)
    result.updated++
  }
  for (const item of plan.forget.slice(0, maxChanges)) {
    if (!mine(item.id)) continue
    if (forgetFact(db, item.id, `saved automatically: ${clip(item.reason, 120)}`)) result.forgotten++
  }
  for (const raw of plan.add.slice(0, maxChanges)) {
    const text = grounded(raw.text, evidence)
    if (text === null) continue
    const item = { ...raw, text }
    if (!safe(item.text)) continue
    // A "preference" the user only gave for this one task isn't one.
    if (item.category === 'preference' && !item.standing) continue
    if (written.some((w) => overlap(w, item.text) >= 0.6)) continue
    rememberFact(db, item.global ? GLOBAL_SCOPE : projectId, item.text, 'scribe', {
      category: item.category,
      // Key facts are in every session's instructions, so a long one (a
      // procedure) stays searchable instead of being carried everywhere.
      key: item.key && item.text.length <= 400
    })
    written.push(item.text)
    result.added++
  }
  return result
}

/**
 * Keeps a saved fact honest: every number in it (a port, a version, a size)
 * must appear in the exchange it came from. A clause with a number the
 * exchange never mentioned is dropped ("... which serves on port 5173" when
 * nobody said 5173); if the number is in the core of the fact, the fact is
 * rejected (null). Models fill in typical-looking details, and a wrong port
 * in memory misleads every later request.
 */
export function grounded(text: string, evidence: string): string | null {
  const numbers = [...new Set(text.match(/\b\d{2,}(?:\.\d+)*\b/g) ?? [])]
  const unsupported = numbers.filter((n) => !evidence.includes(n))
  if (!unsupported.length) return text
  let out = text
  for (const n of unsupported) {
    const escaped = n.replace(/\./g, '\\.')
    out = out.replace(new RegExp(`[,;(]\\s*[^,;()]*\\b${escaped}\\b[^,;()]*\\)?`, 'g'), '')
  }
  if (unsupported.some((n) => new RegExp(`\\b${n.replace(/\./g, '\\.')}\\b`).test(out))) return null
  out = out.replace(/\s+([.,;])/g, '$1').replace(/[,;\s]+$/, '').trim()
  if (!out) return null
  return /[.!?]$/.test(out) ? out : `${out}.`
}

/** Share of the shorter text's words that the other also has (1 = one contains the other). */
function overlap(a: string, b: string): number {
  const tokens = (t: string): Set<string> =>
    new Set((t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !['the', 'and', 'for', 'with', 'that', 'this', 'are', 'was'].includes(w)))
  const x = tokens(a)
  const y = tokens(b)
  if (!x.size || !y.size) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  return shared / Math.min(x.size, y.size)
}

/**
 * A short summary of the conversation so far, to start a fresh Claude
 * session from. Written by Haiku from the saved history.
 */
export async function summarizeConversation(projectId: string): Promise<string> {
  const db = memoryDb()
  const messages = recentMessages(db, projectId, 60)
  if (!messages.length) return ''
  const handoffs = recentHandoffs(db, projectId, 4)
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${clip(m.text, 1200)}`)
    .join('\n\n')
  const work = handoffs.length
    ? `\n\nWork handed to Codex recently:\n${handoffs.map((h) => `- ${clip(h.brief, 160)} (${h.status})`).join('\n')}`
    : ''
  const session = query({
    prompt: `Summarise this conversation between a user and an AI coding assistant, so a fresh session can pick it up without the history. At most 350 words, plain text, no greeting. Use these headings, leaving out any that are empty: STANDING RULES (anything the user said never to do, to leave alone, or always to do, quoted as closely as possible, including files or areas they said not to touch); IN PROGRESS (what was being worked on and what is left); DONE (briefly); DECISIONS (choices made and why, and user preferences that aren't obvious from the code); OPEN (questions or ideas the user raised that are unresolved). Be precise about names of files, features and settings. Don't repeat setup details (how to run it) that are saved elsewhere.\n\n${transcript}${work}`,
    options: {
      cwd: mkdtempSync(join(tmpdir(), 'vibeapp-summary-')),
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      model: 'haiku',
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      settings: { disableClaudeAiConnectors: true },
      thinking: { type: 'disabled' },
      maxTurns: 2
    }
  })
  for await (const message of session) {
    if (message.type !== 'result') continue
    recordUsage(projectId, 'summary', 'claude', countsFromSdkResult(message as Parameters<typeof countsFromSdkResult>[0]))
    if (message.subtype === 'success') return message.result.trim()
    throw new Error(`Summarising the conversation failed (${message.subtype}).`)
  }
  return ''
}
