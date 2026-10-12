#!/usr/bin/env node
// Standalone MCP stdio server for shared agent memory. Spawned as a child
// process so both Claude (via query()'s mcpServers stdio config) and Codex
// (via `-c mcp_servers...` + --approve-for-me) can call the same tools
// against the same storage, verified against the real codex CLI.
//
// Bundled on its own by esbuild (see electron.vite.config.ts), so it shares
// the SQLite memory store with the main process: several of these servers,
// plus the Memory screen, can read and write the database at once.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { join } from 'path'
import {
  GLOBAL_SCOPE,
  openMemory,
  searchFacts,
  keyFactsBlock,
  rememberFact,
  updateFact,
  forgetFact,
  getFact,
  searchMessages,
  recentMessages,
  recentHandoffs,
  getHandoff,
  searchCode,
  countCodeFiles,
  hashFile
} from './store'

const dbPath = process.argv[2]
const projectId = process.argv[3]
const agentSource = process.argv[4] ?? 'claude'
// Used to tell whether a file summary is out of date.
const projectPath = process.argv[5] ?? ''

if (!dbPath || !projectId) {
  process.stderr.write('Usage: memoryServer <dbPath> <projectId> <agentSource> [projectPath]\n')
  process.exit(1)
}

const oneLine = (value, max) => {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const db = openMemory(dbPath)
const CATEGORIES = ['about', 'setup', 'decision', 'preference', 'gotcha', 'other']
const text = (value) => ({ content: [{ type: 'text', text: value }] })
const describe = (f) => `- [${f.category}${f.key ? ', key' : ''}] ${f.text} (id ${f.id})`

/** Only facts from this project or the global scope may be changed from here. */
function ownFact(id) {
  const fact = getFact(db, id)
  if (!fact) return null
  const row = db.prepare('SELECT scope FROM facts WHERE id = ?').get(id)
  return row && (row.scope === projectId || row.scope === GLOBAL_SCOPE) ? fact : null
}

const server = new McpServer({ name: 'vibeapp-memory', version: '2.0.0' })

server.registerTool(
  'recall',
  {
    description:
      'Search the shared project memory (this project plus the user\'s global preferences). Pass a short query about what you need, e.g. "sprites", "deploy", "how to run tests". Without a query, lists the key facts.',
    inputSchema: {
      query: z.string().optional().describe('A few words about what you are looking for.')
    }
  },
  async ({ query }) => {
    if (!query?.trim()) return text(`Key facts:\n${keyFactsBlock(db, projectId)}`)
    const found = searchFacts(db, projectId, query, 12)
    return text(found.length ? `Matches for "${query}":\n${found.map(describe).join('\n')}` : `Nothing remembered matches "${query}".`)
  }
)

server.registerTool(
  'remember',
  {
    description:
      'Save a lasting fact about this project (or, with global: true, a preference that applies to all the user\'s projects). One standalone sentence. If a very similar fact already exists it is updated instead of duplicated.',
    inputSchema: {
      fact: z.string().describe('The fact, as one standalone sentence.'),
      category: z
        .enum(CATEGORIES)
        .describe('about = what the project is; setup = how to run/build/test/deploy; decision = a choice made and why; preference = how the user likes things; gotcha = a non-obvious pitfall; other.'),
      key: z
        .boolean()
        .optional()
        .describe('True for facts needed on almost every request (shown up front in future sessions). Defaults to true for about/setup/preference.'),
      global: z.boolean().optional().describe('True only for preferences that apply to ALL projects. Defaults to false.')
    }
  },
  async ({ fact, category, key, global }) => {
    const result = rememberFact(db, global ? GLOBAL_SCOPE : projectId, fact, agentSource, { category, key })
    return text(
      result.mergedInto
        ? `Updated an existing, very similar fact (id ${result.fact.id}): ${result.fact.text}`
        : `Remembered (id ${result.fact.id}${result.fact.key ? ', key fact' : ''}): ${result.fact.text}`
    )
  }
)

server.registerTool(
  'update',
  {
    description: 'Correct a remembered fact that is wrong or out of date (use its id from recall or the key facts). Prefer this over saving a contradicting new fact.',
    inputSchema: {
      id: z.string(),
      fact: z.string().optional().describe('The corrected sentence.'),
      category: z.enum(CATEGORIES).optional(),
      key: z.boolean().optional()
    }
  },
  async ({ id, fact, category, key }) => {
    if (!ownFact(id)) return text(`No remembered fact with id ${id}.`)
    const updated = updateFact(db, id, { text: fact, category, key })
    return text(`Updated: ${describe(updated)}`)
  }
)

server.registerTool(
  'forget',
  {
    description: 'Retire a remembered fact that is no longer true or useful. The user can still restore it from the Memory screen.',
    inputSchema: {
      id: z.string(),
      reason: z.string().describe('Why, in a few words (e.g. "switched from npm start to Vite").')
    }
  },
  async ({ id, reason }) => {
    if (!ownFact(id)) return text(`No remembered fact with id ${id}.`)
    return text(forgetFact(db, id, `${agentSource}: ${reason}`) ? `Forgot ${id}.` : `${id} was already forgotten.`)
  }
)

server.registerTool(
  'history',
  {
    description:
      'Look back at this project\'s conversation: what the user asked for and what was answered. Pass a few words to search ("shop screen", "login"), or nothing for the most recent messages. Useful for the user\'s exact wording, earlier decisions, and details that fell out of your working context.',
    inputSchema: {
      query: z.string().optional().describe('A few words about what you want to find.'),
      limit: z.number().int().min(1).max(20).optional().describe('How many messages (default 8).')
    }
  },
  async ({ query, limit }) => {
    const max = limit ?? 8
    const found = query?.trim() ? searchMessages(db, projectId, query, max) : recentMessages(db, projectId, max)
    if (!found.length) return text(query?.trim() ? `No past messages match "${query}".` : 'No conversation history yet.')
    const lines = found.map((m) => {
      const when = m.createdAt ? ` ${m.createdAt.slice(0, 10)}` : ''
      const note = m.note ? ` {${oneLine(m.note, 120)}}` : ''
      return `[${m.role}${when}]${note} ${oneLine(m.text, query?.trim() ? 700 : 500)}`
    })
    return text(`${query?.trim() ? `Messages matching "${query}"` : 'Most recent messages'} (oldest first):\n${lines.join('\n')}`)
  }
)

server.registerTool(
  'handoffs',
  {
    description:
      'See what earlier hand-offs from Claude to Codex did in this project: the task, the result, and which files changed. Pass an id (shown in a hand-off result as "#12") to get that hand-off\'s full saved report.',
    inputSchema: {
      limit: z.number().int().min(1).max(15).optional().describe('How many (default 5), newest last.'),
      id: z.number().int().optional().describe('A hand-off number, for its full report.')
    }
  },
  async ({ limit, id }) => {
    if (id !== undefined) {
      const h = getHandoff(db, projectId, id)
      if (!h) return text(`No hand-off #${id} in this project.`)
      return text(
        `#${h.id} [${h.status}] ${h.startedAt.slice(0, 16).replace('T', ' ')}\nTask:\n${h.brief}\n\nFull report:\n${h.report ?? '(none)'}${h.files?.length ? `\n\nFiles changed: ${h.files.join(', ')}` : ''}`
      )
    }
    const items = recentHandoffs(db, projectId, limit ?? 5)
    if (!items.length) return text('No hand-offs yet in this project.')
    return text(
      items
        .map((h) => {
          const files = h.files?.length ? `\n  files: ${h.files.slice(0, 12).join(', ')}${h.files.length > 12 ? '…' : ''}` : ''
          return `#${h.id} [${h.status}] ${h.startedAt.slice(0, 16).replace('T', ' ')} - task: ${oneLine(h.brief, 300)}\n  result: ${oneLine(h.report ?? '(none)', 900)}${files}`
        })
        .join('\n')
    )
  }
)

server.registerTool(
  'where',
  {
    description:
      'Find which files in this project hold something. Searches a map of the source files, each with a one-line summary. Use it before grepping the code: e.g. "collision", "login form", "enemy sprites". Summaries can lag behind recent edits; entries marked changed need a quick look at the file.',
    inputSchema: {
      query: z.string().describe('A few words about what you are looking for.')
    }
  },
  async ({ query }) => {
    const total = countCodeFiles(db, projectId)
    if (!total) return text('The code map is not built yet (it is built in the background after the first request). Search the files directly.')
    const found = searchCode(db, projectId, query, 10)
    if (!found.length) return text(`No file summaries match "${query}" (${total} files mapped). Try other words, or search the files directly.`)
    const lines = found.map((f) => {
      const current = projectPath ? hashFile(join(projectPath, f.path)) : f.hash
      const stale = current !== null && current !== f.hash ? ' (changed since this summary was written)' : ''
      return `- ${f.path}: ${f.summary}${stale}`
    })
    return text(`Files matching "${query}":\n${lines.join('\n')}`)
  }
)

const transport = new StdioServerTransport()
server.connect(transport).catch((err) => {
  process.stderr.write(`vibeapp-memory failed to start: ${err?.message ?? err}\n`)
  process.exit(1)
})
