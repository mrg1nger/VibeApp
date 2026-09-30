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
import {
  GLOBAL_SCOPE,
  openMemory,
  searchFacts,
  keyFactsBlock,
  rememberFact,
  updateFact,
  forgetFact,
  getFact
} from './store'

const dbPath = process.argv[2]
const projectId = process.argv[3]
const agentSource = process.argv[4] ?? 'claude'

if (!dbPath || !projectId) {
  process.stderr.write('Usage: memoryServer <dbPath> <projectId> <agentSource>\n')
  process.exit(1)
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

const transport = new StdioServerTransport()
server.connect(transport).catch((err) => {
  process.stderr.write(`vibeapp-memory failed to start: ${err?.message ?? err}\n`)
  process.exit(1)
})
