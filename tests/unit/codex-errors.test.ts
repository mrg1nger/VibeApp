import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexFailure, codexReport } from '../../src/main/cli/codexExec'

test("a Codex run refused for its usage limit says so, instead of 'no final message'", () => {
  // What codex-cli 0.158 printed when its plan was used up.
  const events = [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'turn.started' },
    { type: 'error', message: 'exceeded retry limit, last status: 429 Too Many Requests' },
    { type: 'turn.failed', error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } }
  ]
  const report = codexReport({ events, finalMessage: '' })
  assert.match(report, /turned Codex away/)
  assert.match(report, /429/)
  assert.match(codexFailure({ events: [{ type: 'error', message: "You've hit your usage limit." }] }) ?? '', /plan limit has been reached/)
})

test('other Codex errors are passed on; a normal answer is used as it is', () => {
  assert.match(codexFailure({ events: [{ type: 'turn.failed', error: { message: 'model not found' } }] }) ?? '', /model not found/)
  assert.equal(codexFailure({ events: [{ type: 'turn.completed' }] }), undefined)
  assert.equal(codexReport({ events: [], finalMessage: 'Done: added the shield.' }), 'Done: added the shield.')
  assert.equal(codexReport({ events: [], finalMessage: '' }), '(Codex finished with no final message.)')
})
