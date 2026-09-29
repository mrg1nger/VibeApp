#!/usr/bin/env node
// Standalone MCP stdio server for shared agent memory. Spawned as a child
// process so both Claude (via query()'s mcpServers stdio config) and Codex
// (via `-c mcp_servers...` + --approve-for-me) can call the same tools
// against the same storage, verified against the real codex CLI.
//
// Bundled on its own by esbuild (see electron.vite.config.ts), so it shares
// the locked storage module with the main process: several of these
// servers, plus the Memory screen, can write the same file at once.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { addFact, listFacts } from './storage'

const projectMemoryPath = process.argv[2]
const globalMemoryPath = process.argv[3]
const agentSource = process.argv[4] ?? 'unknown'

if (!projectMemoryPath || !globalMemoryPath) {
  process.stderr.write('Usage: memoryServer.mjs <projectMemoryPath> <globalMemoryPath> <agentSource>\n')
  process.exit(1)
}

function pathForScope(scope) {
  return scope === 'global' ? globalMemoryPath : projectMemoryPath
}

const server = new McpServer({ name: 'vibeapp-memory', version: '1.0.0' })

server.registerTool(
  'remember',
  {
    description:
      'Save a fact worth remembering for later, either for this project only (default) or across all projects if it is a general preference/habit, not something specific to this codebase.',
    inputSchema: {
      fact: z.string().describe('The fact to remember, written as a standalone sentence.'),
      global: z
        .boolean()
        .optional()
        .describe(
          'Set true only for facts that apply across ALL projects (e.g. a general coding preference), not facts about this specific codebase. Defaults to false (project-scoped).'
        )
    }
  },
  async ({ fact, global }) => {
    addFact(pathForScope(global ? 'global' : 'project'), fact, agentSource)
    return {
      content: [
        { type: 'text', text: `Remembered (${global ? 'global' : 'this project'}): ${fact}` }
      ]
    }
  }
)

server.registerTool(
  'recall',
  {
    description: 'List remembered facts for this project, global facts, or both (default: both).',
    inputSchema: {
      scope: z.enum(['project', 'global', 'both']).optional().describe('Defaults to "both".')
    }
  },
  async ({ scope }) => {
    const effectiveScope = scope ?? 'both'
    const parts = []
    if (effectiveScope === 'project' || effectiveScope === 'both') {
      const facts = listFacts(projectMemoryPath)
      if (facts.length) {
        parts.push('Project facts:\n' + facts.map((f) => `- ${f.text}`).join('\n'))
      }
    }
    if (effectiveScope === 'global' || effectiveScope === 'both') {
      const facts = listFacts(globalMemoryPath)
      if (facts.length) {
        parts.push('Global facts:\n' + facts.map((f) => `- ${f.text}`).join('\n'))
      }
    }
    return {
      content: [{ type: 'text', text: parts.length ? parts.join('\n\n') : '(nothing remembered yet)' }]
    }
  }
)

const transport = new StdioServerTransport()
server.connect(transport).catch((err) => {
  process.stderr.write(`vibeapp-memory failed to start: ${err?.message ?? err}\n`)
  process.exit(1)
})
