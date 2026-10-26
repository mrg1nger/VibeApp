import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { VibeEvent } from '@shared/types'
import { appendEvent, appendUserMessage, loadRecentTranscript, loadTranscript, slimEvent } from '../../src/main/projects/transcript'
import { capBrief, changesSince } from '../../src/main/memory/brief'

test("a tool's whole output and long arguments are shortened in the chat log; what the chat shows is kept", () => {
  const result = slimEvent({ type: 'tool_result', toolUseId: 't1', ok: true, summary: 'Read 3,000 lines', raw: 'x'.repeat(50_000) })
  assert.equal(result.type, 'tool_result')
  if (result.type !== 'tool_result') return
  assert.ok(String(result.raw).length < 2_100)
  assert.equal(result.summary, 'Read 3,000 lines')
  const call = slimEvent({
    type: 'tool_call',
    toolUseId: 't2',
    name: 'Write',
    input: { file_path: 'C:/p/big.js', content: 'y'.repeat(40_000) },
    friendlyLabel: 'Wrote big.js'
  } as VibeEvent)
  if (call.type !== 'tool_call') return
  const input = call.input as { file_path: string; content: string }
  assert.equal(input.file_path, 'C:/p/big.js', 'the path is kept (the chat filters on it)')
  assert.ok(input.content.length < 2_100)
  const small: VibeEvent = { type: 'tool_result', toolUseId: 't3', ok: true, summary: 'ok', raw: 'short' }
  assert.equal(slimEvent(small), small, 'small results are left alone')
})

test('opening a chat loads only its recent requests, and an old, bloated log is slimmed once', () => {
  const id = 'transcript-test'
  for (let i = 1; i <= 12; i++) {
    appendUserMessage(id, `request ${i}`)
    appendEvent(id, { type: 'assistant_text', text: `answer ${i}`, partial: false } as VibeEvent)
  }
  const recent = loadRecentTranscript(id, 5)
  assert.equal(recent.earlier, 7)
  assert.equal(recent.entries.filter((e) => e.direction === 'user').length, 5)
  assert.equal(recent.entries[0].text, 'request 8')
  assert.equal(loadRecentTranscript(id, 0).entries.length, 24, '0 means everything')

  // A log written before slimming: huge tool output on disk.
  const old = 'old-bloated'
  const dir = join(app.getPath('userData'), 'transcripts')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${old}.jsonl`)
  appendFileSync(file, `${JSON.stringify({ direction: 'user', text: 'hello' })}\n`)
  for (let i = 0; i < 120; i++) {
    appendFileSync(file, `${JSON.stringify({ direction: 'event', event: { type: 'tool_result', toolUseId: `r${i}`, ok: true, summary: 'done', raw: 'z'.repeat(60_000) } })}\n`)
  }
  const before = statSync(file).size
  const entries = loadTranscript(old)
  assert.equal(entries.length, 121, 'nothing is lost')
  const after = statSync(file).size
  assert.ok(after < before / 10, `the file shrank (${before} -> ${after})`)
  assert.equal(loadTranscript(old).length, 121)
})

test('the brief is rewritten only after enough changes, and kept to its length', () => {
  const stored = { facts: { a: '1', b: '1', c: '1' }, other: 'x' }
  assert.equal(changesSince(stored, { facts: { a: '1', b: '1', c: '1' }, other: 'x' }), 0)
  assert.equal(changesSince(stored, { facts: { a: '2', b: '1', c: '1', d: '1' }, other: 'x' }), 2, 'one changed, one added')
  assert.equal(changesSince(stored, { facts: { a: '1' }, other: 'y' }), 3, 'two removed, and the rest changed')
  assert.equal(changesSince(undefined, { facts: {}, other: 'x' }), Number.POSITIVE_INFINITY)

  const section = (name: string, words: number): string => `${name}\n${Array.from({ length: words }, (_, i) => `w${i}`).join(' ')}`
  const long = [section('WHAT IT IS', 300), section('HOW IT\'S BUILT', 300), section('PITFALLS', 300)].join('\n')
  const capped = capBrief(long)
  const words = capped.split(/\s+/).filter(Boolean).length
  assert.ok(words <= 650, `capped to ${words} words`)
  assert.match(capped, /^WHAT IT IS/)
  assert.ok(!capped.includes('PITFALLS'), 'a section that does not fit is left out whole')
  assert.equal(capBrief('WHAT IT IS\nA short brief.'), 'WHAT IT IS\nA short brief.')
})
