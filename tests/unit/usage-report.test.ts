import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { codexUsageSince, listRequests, logRequest, logUsage, openMemory, usageByProject } from '../../src/main/memory/store'
import { RequestRecorder, stepKind } from '../../src/main/usage/requestLog'
import { buildReport, stepMix, weight } from '../../src/main/usage/report'
import { routeMessage } from '../../src/main/orchestrator/routing'
import { approvedPlanNote, PLAN_INSTRUCTIONS } from '@shared/plan'
import type { AppSettings, VibeEvent } from '@shared/types'

const db = openMemory(join(mkdtempSync(join(tmpdir(), 'vibeapp-unit-')), 'memory.db'))

test("Claude's tool calls are sorted by what they were for", () => {
  assert.equal(stepKind('mcp__vibe_tools__run_codex_subtask'), 'handoff')
  assert.equal(stepKind('mcp__vibe_tools__run_deploy'), 'deploy')
  assert.equal(stepKind('mcp__vibe_tools__plan_progress'), 'progress')
  assert.equal(stepKind('mcp__ext_browser_testing_playwrig__browser_click'), 'browser')
  assert.equal(stepKind('mcp__vibe_memory__where'), 'read')
  assert.equal(stepKind('mcp__vibe_memory__recall'), 'memory')
  assert.equal(stepKind('Grep'), 'read')
  assert.equal(stepKind('Write'), 'edit')
  assert.equal(stepKind('Bash', { command: 'node --test tests/*.mjs' }), 'command')
  assert.equal(stepKind('Bash', { command: 'scp -i ~/.ssh/key game.tar.gz root@1.2.3.4:/tmp' }), 'server')
  assert.equal(stepKind('Agent'), 'helper')
})

test("a request's events become one row: steps by kind, hand-offs, tokens, outcome", () => {
  const r = new RequestRecorder({ projectId: 'p1', mode: 'plan_build', text: 'Approved the plan.', balance: 'codex', route: 'Codex · does most of the work', size: 'normal' })
  const events: VibeEvent[] = [
    { type: 'tool_call', toolUseId: '1', name: 'mcp__vibe_tools__plan_progress', input: {}, friendlyLabel: '' },
    { type: 'tool_call', toolUseId: '2', name: 'mcp__vibe_tools__run_codex_subtask', input: {}, friendlyLabel: '' },
    { type: 'tool_call', toolUseId: '3', name: 'Bash', input: { command: 'ssh root@host systemctl restart game' }, friendlyLabel: '' },
    { type: 'tool_call', toolUseId: '4', name: 'Read', input: {}, friendlyLabel: '', parentToolUseId: 'helper' },
    { type: 'usage', steps: 12, fresh: 1000, cached: 50_000, output: 800, model: 'claude-sonnet-5-5' }
  ]
  for (const e of events) assert.equal(r.observe(e), false)
  assert.equal(r.observe({ type: 'turn_complete' }), true, 'turn_complete ends it')
  const row = r.finish({ fresh: 10, cached: 20, output: 30 })
  assert.deepEqual(row.tools, { progress: 1, handoff: 1, server: 1 }, "a helper's own steps aren't Claude's")
  assert.equal(row.handoffs, 1)
  assert.equal(row.claudeSteps, 12)
  assert.equal(row.outcome, 'done')
  assert.equal(row.mode, 'plan_build')
  assert.deepEqual(row.codex, { fresh: 10, cached: 20, output: 30 })

  const stopped = new RequestRecorder({ projectId: 'p1', mode: 'build', text: 'x' })
  stopped.observe({ type: 'stopped' })
  assert.equal(stopped.finish().outcome, 'stopped')
})

test('request rows are stored and read back, and Codex tokens since a time are summed', () => {
  const start = new Date(Date.now() - 1000).toISOString()
  logUsage(db, { projectId: 'p2', kind: 'handoff', agent: 'codex', fresh: 100, cached: 1000, output: 50 })
  logUsage(db, { projectId: 'p2', kind: 'request', agent: 'claude', fresh: 999, cached: 0, output: 0 })
  assert.deepEqual(codexUsageSince(db, 'p2', start), { fresh: 100, cached: 1000, output: 50 })
  const r = new RequestRecorder({ projectId: 'p2', mode: 'build', text: 'Add a shop' })
  r.observe({ type: 'tool_call', toolUseId: '1', name: 'Edit', input: {}, friendlyLabel: '' })
  logRequest(db, r.finish(codexUsageSince(db, 'p2', start)))
  const rows = listRequests(db, start, 'p2')
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].tools, { edit: 1 })
  assert.equal(rows[0].codex.cached, 1000)
  assert.ok(usageByProject(db, start).some((u) => u.projectId === 'p2' && u.agent === 'codex'))
})

test('the report says where usage went, how Codex was used, and names the expensive requests', () => {
  const base = { at: new Date().toISOString(), projectId: 'yay', balance: 'codex', size: 'normal', model: 'sonnet', outcome: 'done', seconds: 600, codex: { fresh: 1000, cached: 100_000, output: 5000 } }
  const report = buildReport({
    days: 7,
    usage: [
      { projectId: 'yay', agent: 'claude', kind: 'request', model: 'sonnet', runs: 3, fresh: 100_000, cached: 2_000_000, output: 20_000 },
      { projectId: 'yay', agent: 'claude', kind: 'scribe', model: null, runs: 9, fresh: 30_000, cached: 0, output: 2000 },
      { projectId: 'yay', agent: 'codex', kind: 'handoff', model: null, runs: 2, fresh: 5000, cached: 90_000, output: 4000 }
    ],
    requests: [
      { ...base, mode: 'plan_build', route: 'Codex · does most of the work', text: 'Approved the plan.', claudeSteps: 85, tools: { handoff: 1, browser: 40, server: 12, progress: 8 }, handoffs: 1, claude: { fresh: 50_000, cached: 3_000_000, output: 9000 } },
      { ...base, mode: 'build', route: 'Codex · does most of the work', text: 'Fix the clicks', claudeSteps: 10, tools: { read: 5, edit: 3 }, handoffs: 0, claude: { fresh: 5000, cached: 200_000, output: 2000 } },
      { ...base, mode: 'plan', route: null, text: 'Plan the admin panel', claudeSteps: 15, tools: { read: 10 }, handoffs: 0, claude: { fresh: 8000, cached: 300_000, output: 3000 } }
    ],
    projectNames: new Map([['yay', 'yay']]),
    plans: ['Claude Weekly 44% used']
  })
  assert.match(report, /Claude, by project/)
  assert.match(report, /- yay: 100%/)
  assert.match(report, /Building an approved plan: 1/)
  assert.match(report, /Teamwork \(2 requests the slider sent to Codex\)/)
  assert.match(report, /Called Codex: 1 \(50%\)/)
  assert.match(report, /checked in a browser in 1, ran server commands in 1/)
  assert.match(report, /requests ran 3\+ server commands by hand/)
  assert.match(report, /Most expensive requests\n- .*Approved the plan/)
  assert.match(stepMix({ browser: 3, edit: 1 }), /^75% browser checks, 25% editing files itself$/)
  assert.ok(weight({ fresh: 0, cached: 1000, output: 0 }) === 100 && weight({ fresh: 300, cached: 0, output: 0 }, 'haiku') === 100)
})

test('Codex-led asks Codex to check its own work and Claude to deploy with the saved Deploy', async () => {
  const settings = { smartRouting: true, aiRouting: false, agentBalance: 'codex', claudeModel: 'sonnet' } as unknown as AppSettings
  const route = await routeMessage('Add a shop screen with a sell button', settings)
  assert.match(route.note ?? '', /Codex builds and tests/)
  assert.match(route.note ?? '', /don't re-read the diff with git or repeat the testing yourself/)
  assert.match(route.note ?? '', /run_deploy/)
  const leaning = await routeMessage('Add a shop screen with a sell button', { ...settings, agentBalance: 'lean-codex' } as AppSettings)
  assert.match(leaning.note ?? '', /how to check the work/)
})

test('the slider still applies with smart model switching off (only model changes stop)', async () => {
  const settings = { smartRouting: false, aiRouting: true, agentBalance: 'codex', claudeModel: 'opus' } as unknown as AppSettings
  const route = await routeMessage('Make the title blue', settings)
  assert.match(route.note ?? '', /Codex-led/, 'the slider was ignored before')
  assert.equal(route.model, null, 'no model switching')
  assert.equal(route.skipReview, false)
  const claudeLed = await routeMessage('Add a shop', { ...settings, agentBalance: 'claude' } as AppSettings)
  assert.match(claudeLed.note ?? '', /do the work yourself/)
})

test('plans put checks with the building step and report progress once per step', () => {
  const note = approvedPlanNote('## Steps\n1. (Codex) Build it\n2. (Claude) Deploy with the saved Deploy')
  assert.match(note, /one call per step/)
  assert.match(note, /next set to the step you start next/)
  assert.match(note, /run_deploy/)
  assert.match(PLAN_INSTRUCTIONS, /whoever builds it checks it/)
})
