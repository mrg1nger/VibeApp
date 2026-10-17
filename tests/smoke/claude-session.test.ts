import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeSession } from '../../src/main/orchestrator/session'
import { updateSettings } from '../../src/main/settings/store'
import { memoryDb } from '../../src/main/memory/paths'
import { rememberFact } from '../../src/main/memory/store'
import { makeProject, projectId, replyText, turn } from '../support/fixtures'

// VibeApp's own Claude session class against the real Claude Code (on Haiku).

test('a normal request runs, reports its size and ends once', { timeout: 300_000 }, async () => {
  updateSettings({ claudeModel: 'haiku', autoMemory: false })
  const s = new ClaudeSession(projectId('basic'), makeProject())
  const events = await turn(s, 'Read shop.js and tell me the sword price. One line.')
  assert.match(replyText(events), /140/)
  assert.equal(events.filter((e) => e.type === 'turn_complete').length, 1)
  assert.ok(s.contextTokens() > 1000, `context size known: ${s.contextTokens()}`)
  s.dispose()
})

test('compaction shrinks the conversation, keeps rules, and Claude then sees newly saved facts', { timeout: 400_000 }, async () => {
  updateSettings({ claudeModel: 'haiku', autoMemory: false })
  const pid = projectId('compact')
  const s = new ClaudeSession(pid, makeProject())
  await turn(s, 'Read shop.js and tell me the sword price. Standing rule: never touch battle.js. One line.')
  // Saved just before compacting, as the save pass would.
  rememberFact(memoryDb(), pid, 'The project codename is BLUEHERON.', 'user', { category: 'about', key: true })
  const seen: string[] = []
  s.on('event', (e) => seen.push(e.type))
  const result = await s.compact('Keep the standing rules and the facts learned.')
  assert.ok(result, 'compacted')
  assert.ok(result.after < result.before, `${result.before} -> ${result.after}`)
  assert.ok(!seen.includes('turn_complete'), 'a compaction is not a reply')
  const answer = replyText(await turn(s, 'What standing rule did I give you, and what is the project codename from your key facts? One line.'))
  assert.match(answer, /battle/i)
  assert.match(answer, /BLUEHERON/)
  s.dispose()
})

test('pressing Stop during a compaction does not mark the next reply as stopped', { timeout: 400_000 }, async () => {
  updateSettings({ claudeModel: 'haiku', autoMemory: false })
  const s = new ClaudeSession(projectId('stopcompact'), makeProject())
  await turn(s, 'Read shop.js and tell me the sword price. One line.')
  const compacting = s.compact('Keep the facts.')
  setTimeout(() => void s.stop(), 1500)
  await compacting
  const events = await turn(s, 'Say OK.')
  assert.ok(!events.some((e) => e.type === 'stopped'), events.map((e) => e.type).join(','))
  s.dispose()
})

test('helper agents run inside the request and stay in the project', { timeout: 400_000 }, async () => {
  updateSettings({ claudeModel: 'haiku', autoMemory: false })
  const dir = makeProject()
  const s = new ClaudeSession(projectId('helpers'), dir)
  const events = await turn(
    s,
    'Use helper agents (the Agent tool): the explorer to find the sword price, and the test-runner to say whether this project has any test files. Then answer in two lines.'
  )
  const helperCalls = events.filter((e) => e.type === 'tool_call' && (e.name === 'Agent' || e.name === 'Task') && !e.parentToolUseId)
  const inner = events.filter((e) => e.type === 'tool_call' && e.parentToolUseId)
  assert.ok(helperCalls.length >= 1, 'started a helper')
  assert.ok(inner.length >= 1, 'helper steps are tagged to their card')
  assert.equal(events.filter((e) => e.type === 'turn_complete').length, 1, 'finished inside the request')
  assert.match(replyText(events), /140/)
  const outside = inner.filter((e) => {
    const input = JSON.stringify(e.type === 'tool_call' ? e.input : '').replace(/\\\\/g, '/').toLowerCase()
    return /[a-z]:\//.test(input) && !input.includes(dir.replace(/\\/g, '/').toLowerCase())
  })
  assert.equal(outside.length, 0, `helper looked outside the project: ${JSON.stringify(outside).slice(0, 300)}`)
  s.dispose()
})
