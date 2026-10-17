import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPlainQuestion } from '../../src/main/orchestrator/questions'
import { parseClassification } from '../../src/main/orchestrator/classifier'
import { applyBalance, autoLean } from '@shared/balance'

test('plain questions are recognised', () => {
  for (const text of [
    'Looks good. Quick question what tiers of armor, weapons, and accessories are there?',
    'what tiers of armor are there?',
    'How many realms does the game have?',
    'Where is the spawn rate defined?',
    'Quick question: which file handles the event log?',
    'Is there a limit on party size?',
    'Why does the server restart every hour?'
  ]) {
    assert.equal(isPlainQuestion(text), true, text)
  }
})

test('requests to change things stay Build requests', () => {
  for (const text of [
    'Add a new armor tier called mythic.',
    'Can you add a fourth realm?',
    'Make the torches glow more, ok?',
    'Fix the bug where the player falls in water. Why does it happen?',
    'Looks good.',
    'Rename the battle module please?',
    'Could you tell me what changed?',
    'Update the readme and tell me what tiers exist?',
    'check http://example.com/page?id=1',
    'What does this do? ```js\nfoo()\n```'
  ]) {
    assert.equal(isPlainQuestion(text), false, text)
  }
})

test('classifier replies are parsed strictly', () => {
  assert.deepEqual(parseClassification('{"size":"quick","codex":"none","reason":"tiny"}'), {
    size: 'quick',
    codex: 'none',
    reason: 'tiny'
  })
  assert.equal(parseClassification("You've hit your session limit · resets 7:30pm"), null)
  assert.equal(parseClassification('{"size":"huge","codex":"none"}'), null)
})

test('the balance slider only ever shifts work, and quick requests stay with Claude', () => {
  assert.equal(applyBalance('most', 'quick', 2), 'none')
  assert.equal(applyBalance('none', 'normal', 2), 'most')
  assert.equal(applyBalance('most', 'normal', -2), 'none')
  assert.equal(applyBalance('most', 'complex', -2), 'some')
  assert.equal(autoLean(10, 90), 2)
  assert.equal(autoLean(undefined, 90), 0)
})
