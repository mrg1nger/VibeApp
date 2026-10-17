import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ClaudeSession } from '../../src/main/orchestrator/session'
import { updateSettings } from '../../src/main/settings/store'
import type { VibeEvent } from '@shared/types'
import { makeProject, projectId, testSession, turn } from '../support/fixtures'

// Claude (Haiku, to keep it cheap) hands work to the real Codex CLI through
// VibeApp's run_codex_subtask tool, as it does in the app.

const HANDOFF = 'mcp__vibe_tools__run_codex_subtask'
type ToolResult = Extract<VibeEvent, { type: 'tool_result' }>

function handoffResults(events: VibeEvent[]): { prompt: string; text: string; ok: boolean }[] {
  const calls = new Map<string, string>()
  for (const e of events) {
    if (e.type === 'tool_call' && e.name === HANDOFF && !e.parentToolUseId) {
      calls.set(e.toolUseId, String((e.input as { prompt?: string }).prompt ?? ''))
    }
  }
  return events
    .filter((e): e is ToolResult => e.type === 'tool_result' && calls.has(e.toolUseId))
    .map((e) => ({
      prompt: calls.get(e.toolUseId)!,
      ok: e.ok,
      text: Array.isArray(e.raw)
        ? (e.raw as { text?: string }[]).map((b) => b.text ?? '').join('\n')
        : String(e.raw ?? e.summary)
    }))
}

function session(t: { after: (fn: () => void) => void }): { s: ClaudeSession; dir: string } {
  updateSettings({ claudeModel: 'haiku', autoMemory: false })
  const dir = makeProject()
  return { s: testSession(t, projectId('collab'), dir), dir }
}

test('Claude hands a task to Codex and gets back the files changed and the check result', { timeout: 600_000 }, async (t) => {
  const { s, dir } = session(t)
  const events = await turn(
    s,
    'Use the run_codex_subtask tool (do not edit any files yourself) to have Codex create util.js exporting a function add(a, b) that returns their sum. Then reply DONE.',
    540_000
  )
  const results = handoffResults(events)
  if (results.length !== 1) {
    for (const [i, r] of results.entries()) {
      console.log(`  hand-off ${i + 1} (${r.ok ? 'ok' : 'error'}): ${r.prompt.slice(0, 160)}\n    -> ${r.text.slice(0, 400).replace(/\n/g, ' | ')}`)
    }
  }
  assert.equal(results.length, 1, 'one hand-off')
  assert.ok(results[0].ok, results[0].text)
  assert.match(results[0].text, /files changed: .*util\.js/)
  assert.ok(existsSync(join(dir, 'util.js')), 'Codex created the file')
})

test('a second hand-off in the same request continues the same Codex session', { timeout: 900_000 }, async (t) => {
  const { s, dir } = session(t)
  const events = await turn(
    s,
    'Make two hand-offs with the run_codex_subtask tool, one after the other: wait for the first to finish before starting the second. First: create notes.txt containing the line "one". Second: append the line "two" to notes.txt. Do not edit files yourself. Then reply DONE.',
    840_000
  )
  const results = handoffResults(events)
  assert.equal(results.length, 2, 'two hand-offs')
  assert.match(results[1].text, /Continued the earlier Codex session/)
  assert.match(readFileSync(join(dir, 'notes.txt'), 'utf-8'), /one[\s\S]*two/)
})

test('two hand-offs asked for at once are kept apart (each reports only its own files)', { timeout: 900_000 }, async (t) => {
  const { s, dir } = session(t)
  const events = await turn(
    s,
    'In ONE message, call the run_codex_subtask tool twice at the same time (two tool calls in parallel, not one after the other): the first creates x.txt containing "x"; the second creates y.txt containing "y". Do not edit files yourself. Then reply DONE.',
    840_000
  )
  const results = handoffResults(events)
  assert.equal(results.length, 2, 'two hand-offs')
  // Were they really asked for together (both calls before either result)?
  const ids = new Set(events.filter((e) => e.type === 'tool_call' && e.name === HANDOFF).map((e) => (e as { toolUseId: string }).toolUseId))
  const order = events
    .filter((e) => (e.type === 'tool_call' || e.type === 'tool_result') && ids.has(e.toolUseId))
    .map((e) => e.type)
  console.log(`  hand-off order: ${order.join(' > ')}`)
  assert.ok(existsSync(join(dir, 'x.txt')) && existsSync(join(dir, 'y.txt')), 'both files exist')
  for (const r of results) {
    const mine = /x\.txt/.test(r.prompt) ? 'x.txt' : 'y.txt'
    const other = mine === 'x.txt' ? 'y.txt' : 'x.txt'
    const changed = /files changed: ([^\]]*)/.exec(r.text)?.[1] ?? ''
    assert.ok(changed.includes(mine), `${mine} hand-off lists its own file: ${changed}`)
    assert.ok(!changed.includes(other), `${mine} hand-off doesn't claim ${other}: ${changed}`)
  }
})
