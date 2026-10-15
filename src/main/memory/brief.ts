import { query } from '@anthropic-ai/claude-agent-sdk'
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { detectSecrets } from '@shared/secretPatterns'
import { resolveClaudeExecutable } from '../cli/claudeBinary'
import { countsFromSdkResult, recordUsage } from '../usage/tokens'
import { claudeHelpersAllowed } from '../usage/usage'
import { recentNotableCommands } from './commands'
import { memoryDb } from './paths'
import { getMeta, listCodeFiles, listFacts, setMeta } from './store'

// A short, structured "what a newcomer needs to know" document for each
// project, kept in the database and shown at the start of every new session.
// Facts are a list; this is the same knowledge arranged so someone can pick
// the project up from it. Rewritten rarely, from what's already saved.

export interface Brief {
  text: string
  updatedAt: string
}

interface StoredBrief extends Brief {
  /** Digest of what it was written from, so an unchanged project isn't rewritten. */
  basis: string
}

const MAX_WORDS = 500
const MIN_GAP_MS = 30 * 60_000
const MIN_FACTS = 6

const key = (projectId: string): string => `brief:${projectId}`

function read(projectId: string): StoredBrief | undefined {
  try {
    const raw = getMeta(memoryDb(), key(projectId))
    return raw ? (JSON.parse(raw) as StoredBrief) : undefined
  } catch {
    return undefined
  }
}

export function getBrief(projectId: string): Brief | undefined {
  const stored = read(projectId)
  return stored ? { text: stored.text, updatedAt: stored.updatedAt } : undefined
}

/** The brief as a block for an agent's instructions, or undefined if there isn't one yet. */
export function briefBlock(projectId: string): string | undefined {
  const brief = getBrief(projectId)
  return brief?.text.trim() ? brief.text.trim() : undefined
}

function packageScripts(projectPath: string): string {
  try {
    const file = join(projectPath, 'package.json')
    if (!existsSync(file)) return ''
    const pkg = JSON.parse(readFileSync(file, 'utf-8')) as { name?: string; scripts?: Record<string, string> }
    return Object.entries(pkg.scripts ?? {})
      .slice(0, 15)
      .map(([name, cmd]) => `${name}: ${String(cmd).slice(0, 120)}`)
      .join('\n')
  } catch {
    return ''
  }
}

const NOTABLE_FILES = ['deploy.sh', 'Dockerfile', 'docker-compose.yml', 'Makefile', 'vercel.json', 'netlify.toml', 'fly.toml', 'Procfile', '.github/workflows']

function gather(projectId: string, projectPath: string): { prompt: string; basis: string; factCount: number } {
  const db = memoryDb()
  const facts = listFacts(db, projectId)
  const lines = facts
    .slice(0, 80)
    .map((f) => `- (${f.category}${f.key ? ', key' : ''}) ${f.text.slice(0, 600)}`)
    .join('\n')
  const files = listCodeFiles(db, projectId, 60)
    .map((f) => `${f.path}: ${f.summary}`)
    .join('\n')
  const commands = recentNotableCommands(projectId, 15).join('\n')
  const scripts = packageScripts(projectPath)
  const present = NOTABLE_FILES.filter((f) => existsSync(join(projectPath, f))).join(', ')
  const previous = read(projectId)?.text ?? ''

  const prompt = `You maintain the project brief for a software project: a short document that lets a capable newcomer (an AI assistant starting a fresh session with no memory of the work so far) pick the project up. Write it from the material below only.

Rules:
- At most ${MAX_WORDS} words, plain text, no preamble. Use these headings, leaving out any you have no material for: WHAT IT IS; HOW IT'S BUILT; RUN, TEST, DEPLOY (what each routine is and the shape of its steps in one or two lines, for example "build an archive, copy it to the server over ssh, unpack, restart the service, check the site"; name the key tools, hosts and service names; do not copy whole command lines, because the exact steps are saved as facts starting "Procedure -" that can be looked up with recall); SERVICES AND ENVIRONMENTS; CONVENTIONS AND RULES (the user's standing rules, quoted closely); STATUS (what exists and what is in progress); PITFALLS.
- State only what the material supports. Never invent ports, hosts, paths, versions or commands. If something is unknown, leave it out.
- Never include secrets, keys, passwords or tokens. Refer to them by environment variable name only.
- If a previous brief is given, keep what is still true and update it; don't start over or drop details that are still supported.

Remembered facts:
${lines || '(none)'}

Source files (path: what it is):
${files || '(not mapped yet)'}

package.json scripts:
${scripts || '(none)'}

Notable files present: ${present || '(none)'}

Commands that were run recently:
${commands || '(none)'}

Previous brief:
${previous || '(none)'}`

  const basis = createHash('sha1')
    .update(JSON.stringify([facts.map((f) => [f.id, f.updatedAt, f.forgottenAt]), commands, scripts, present]))
    .digest('hex')
  return { prompt, basis, factCount: facts.length }
}

const running = new Set<string>()

/** Writes (or updates) the brief. Resolves to the new brief, or undefined when nothing needed doing. */
export async function refreshBrief(
  projectId: string,
  projectPath: string,
  options: { force?: boolean } = {}
): Promise<Brief | undefined> {
  if (running.has(projectId)) return undefined
  const { prompt, basis, factCount } = gather(projectId, projectPath)
  const stored = read(projectId)
  if (!options.force && stored?.basis === basis) return undefined
  if (factCount < 2 && !stored) return undefined // nothing to base one on yet
  running.add(projectId)
  try {
    const session = query({
      prompt,
      options: {
        cwd: mkdtempSync(join(tmpdir(), 'vibeapp-brief-')),
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
      recordUsage(projectId, 'brief', 'claude', countsFromSdkResult(message as Parameters<typeof countsFromSdkResult>[0]))
      if (message.subtype !== 'success') throw new Error(`Writing the project brief failed (${message.subtype}).`)
      const text = String(message.result).trim()
      if (!text) return undefined
      // A brief that picked up something secret-looking is dropped, not saved.
      if (detectSecrets(text).length) return undefined
      const saved: StoredBrief = { text, updatedAt: new Date().toISOString(), basis }
      setMeta(memoryDb(), key(projectId), JSON.stringify(saved))
      return { text, updatedAt: saved.updatedAt }
    }
    return undefined
  } finally {
    running.delete(projectId)
  }
}

const lastTry = new Map<string, number>()

/** Refreshes in the background when it's worth it and Claude has room. Never throws. */
export function maybeRefreshBrief(projectId: string, projectPath: string): void {
  try {
    if (!claudeHelpersAllowed() || running.has(projectId)) return
    if (Date.now() - (lastTry.get(projectId) ?? 0) < MIN_GAP_MS) return
    const existing = read(projectId)
    if (!existing && listFacts(memoryDb(), projectId).length < MIN_FACTS) return
    lastTry.set(projectId, Date.now())
    refreshBrief(projectId, projectPath).catch((err) => console.warn('Project brief refresh failed:', (err as Error).message))
  } catch (err) {
    console.warn('Project brief check failed:', (err as Error).message)
  }
}
