import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { runTakeover, takeCatchUpNote } from '../../src/main/orchestrator/takeover'
import { askClaude, askCodex } from '../../src/main/chat/ask'
import { runTalk } from '../../src/main/chat/talk'
import { getUsage } from '../../src/main/usage/usage'
import { memoryDbPath, memoryServerScriptPath } from '../../src/main/memory/paths'
import { updateSettings } from '../../src/main/settings/store'
import type { VibeEvent } from '@shared/types'
import { makeProject, projectId } from '../support/fixtures'

function takeover(pid: string, dir: string, text: string, signal = new AbortController().signal): Promise<VibeEvent[]> {
  const events: VibeEvent[] = []
  return runTakeover({
    projectId: pid,
    projectPath: dir,
    text,
    images: [],
    resetsAt: null,
    unsandboxed: false,
    emit: (e) => events.push(e),
    signal
  }).then(() => events)
}

test('both usage meters can be read', { timeout: 90_000 }, async () => {
  for (const cli of ['claude', 'codex'] as const) {
    const u = await getUsage(cli, true)
    assert.notEqual(u.status, 'error', `${cli}: ${u.message}`)
  }
})

test('a takeover does the work on Codex, continues its session, and leaves a catch-up note', { timeout: 600_000 }, async () => {
  const pid = projectId('takeover')
  const dir = makeProject()
  let events = await takeover(pid, dir, 'Create hello.js that prints "hello takeover". One line.')
  assert.deepEqual(events.at(-1), { type: 'turn_complete' })
  assert.ok(existsSync(join(dir, 'hello.js')))
  events = await takeover(pid, dir, 'Now change it to print "hello again" instead, same file.')
  assert.match(readFileSync(join(dir, 'hello.js'), 'utf-8'), /hello again/)
  const note = takeCatchUpNote(pid) ?? ''
  assert.match(note, /hello\.js/)
  assert.match(note, /uncommitted/)
  assert.equal(takeCatchUpNote(pid), undefined, 'the note is given once')
})

test('Stop ends a takeover', { timeout: 120_000 }, async () => {
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 6000)
  const events = await takeover(projectId('stop'), makeProject(), 'Write a 500-line utility library in big.js with comments.', abort.signal)
  const types = events.map((e) => e.type)
  assert.ok(types.includes('stopped'), types.join(','))
  assert.equal(types.at(-1), 'turn_complete')
})

test('Ask mode answers from the files and cannot change them', { timeout: 300_000 }, async () => {
  const dir = makeProject()
  const memory = { scriptPath: memoryServerScriptPath(), dbPath: memoryDbPath(), projectId: projectId('ask'), projectPath: dir }
  const a = await askClaude({ prompt: 'What does the sword cost in shop.js?', cwd: dir, system: 'Answer briefly.', model: 'haiku', abort: new AbortController(), readFiles: true, memory })
  assert.match(a.text, /140/)
  await askClaude({ prompt: 'Create a file named pwned.txt containing hi.', cwd: dir, system: 'Answer briefly.', model: 'haiku', abort: new AbortController(), readFiles: true, resume: a.sessionId })
  assert.equal(existsSync(join(dir, 'pwned.txt')), false)
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 1500)
  await assert.rejects(askCodex({ prompt: 'Write a very long essay about computing.', abort }))
})

test('the Chat tab carries a conversation over when switching from Claude to Codex', { timeout: 300_000 }, async () => {
  updateSettings({ claudeModel: 'haiku' })
  const id = randomUUID()
  await runTalk(id, 'My favourite number is 7. Just say OK.', 'claude')
  const c = await runTalk(id, 'What is my favourite number? Answer with only the number.', 'codex')
  assert.match(c.messages.at(-1)!.text, /7/)
  assert.equal(c.messages.at(-1)!.agent, 'codex')
})
