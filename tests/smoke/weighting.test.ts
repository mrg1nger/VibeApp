import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'fs'
import { join } from 'path'
import { ClaudeSession } from '../../src/main/orchestrator/session'
import { routeMessage } from '../../src/main/orchestrator/routing'
import { requestClassifier } from '../../src/main/orchestrator/classifier'
import { getSettings, updateSettings } from '../../src/main/settings/store'
import type { AgentBalance } from '@shared/balance'
import type { VibeEvent } from '@shared/types'
import { answerPrompts, makeProject, projectId, turn } from '../support/fixtures'

// The Claude/Codex slider, end to end: VibeApp's routing turns the slider and
// Haiku's judgement of the request into a note for Claude, and Claude decides
// whether to hand work to Codex. This checks both ends of the slider actually
// change who builds. (Claude runs on Haiku here; a stronger model may follow
// the note even more closely.)

const REQUEST =
  'Add a module inventory.js with three functions, addItem(inventory, item), removeItem(inventory, name) and countItems(inventory), and a test file inventory.test.js using node:test that checks all three. Make sure the tests pass.'

// The classifier keeps a Claude process warm; let the test runner exit.
after(() => requestClassifier.dispose())

async function runWith(balance: AgentBalance): Promise<{ handoffs: number; note: string; dir: string; prompts: string[] }> {
  updateSettings({ claudeModel: 'haiku', agentBalance: balance, smartRouting: true, aiRouting: true, autoMemory: false })
  const pid = projectId(`weight_${balance}`)
  const dir = makeProject()
  const route = await routeMessage(REQUEST, getSettings(), { projectId: pid })
  const s = new ClaudeSession(pid, dir)
  const prompts = answerPrompts(s)
  try {
    // As the app does: the routing note goes in front of the user's words.
    const events: VibeEvent[] = await turn(s, [route.note, REQUEST].filter(Boolean).join('\n\n'), 600_000)
    const handoffs = events.filter((e) => e.type === 'tool_call' && e.name === 'mcp__vibe_tools__run_codex_subtask').length
    console.log(`  ${balance}: ${route.label ?? '-'} · ${route.reason ?? ''} -> ${handoffs} hand-off(s)`)
    for (const p of prompts) console.log(`  prompt answered: ${p}`)
    return { handoffs, note: route.note ?? '', dir, prompts }
  } finally {
    s.dispose()
  }
}

test('Codex-led: Claude hands the building to Codex', { timeout: 660_000 }, async () => {
  const r = await runWith('codex')
  assert.match(r.note, /Codex-led|Codex should build/, 'the routing note asks for Codex')
  assert.ok(r.handoffs >= 1, 'Claude handed work to Codex')
  assert.ok(existsSync(join(r.dir, 'inventory.js')), 'the module was built')
})

test('Claude-led: Claude does the work itself', { timeout: 660_000 }, async () => {
  const r = await runWith('claude')
  assert.match(r.note, /do the work yourself/, 'the routing note asks Claude to build')
  assert.equal(r.handoffs, 0, 'no hand-offs')
  assert.ok(existsSync(join(r.dir, 'inventory.js')), 'the module was built')
})
