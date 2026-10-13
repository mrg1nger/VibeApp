import type { ExtensionCatalogItem } from '@shared/types'

// A short, hand-picked list of well-known tool servers. Each is run with npx,
// so it needs Node.js installed; nothing is downloaded until it's first used.

export const CATALOG: ExtensionCatalogItem[] = [
  {
    id: 'context7',
    name: 'Up-to-date docs (Context7)',
    description:
      'Looks up current documentation for libraries and frameworks, so the agents stop guessing at APIs that have changed.',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    envNeeded: [],
    instructions:
      'The Context7 tools look up current documentation for a library or framework. Use them before writing code against an API you are not certain about.',
    requires: 'node'
  },
  {
    id: 'playwright',
    name: 'Browser testing (Playwright)',
    description:
      'Lets the agents open the running app in a real browser, click through it, and check that it works.',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--headless'],
    envNeeded: [],
    instructions:
      'The Playwright tools drive a real (headless) browser. After building something with a page or UI, open it from the preview address and check that the main flow works before saying it is done.',
    requires: 'node'
  },
  {
    id: 'sequential-thinking',
    name: 'Step-by-step thinking',
    description: 'A scratchpad for working through hard problems in ordered steps before acting.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    envNeeded: [],
    instructions: 'For a hard design or debugging problem, use the sequential thinking tool to lay out steps before changing code.',
    requires: 'node'
  }
]
