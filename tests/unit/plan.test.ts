import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvedPlanNote, parsePlanSteps } from '@shared/plan'

test("a plan's steps are read from its Steps section, with who does each", () => {
  const plan = `Add a sell price to the shop.

## Steps
1. (Claude) Add sellPrice(item) to shop.js, returning half the price rounded down.
2. **(Codex)** Write tests in shop.test.js for every item.
3. Codex: run the tests and fix anything that fails.

## Risks
1. Nothing serious.`
  const steps = parsePlanSteps(plan)
  assert.equal(steps.length, 3, 'only the Steps section, not Risks')
  assert.deepEqual(steps[0], { text: 'Add sellPrice(item) to shop.js, returning half the price rounded down.', who: 'claude' })
  assert.equal(steps[1].who, 'codex')
  assert.equal(steps[1].text, 'Write tests in shop.test.js for every item.')
  assert.equal(steps[2].who, 'codex')
})

test('without a Steps heading, the first numbered list is used; no list means no steps', () => {
  assert.equal(parsePlanSteps('Plan:\n1. Do one thing\n2. Do another').length, 2)
  assert.deepEqual(parsePlanSteps('Just a paragraph, no list.'), [])
})

test('the build note tells Claude to report progress and hand Codex steps to Codex', () => {
  const note = approvedPlanNote('## Steps\n1. (Codex) Build it')
  assert.match(note, /plan_progress/)
  assert.match(note, /run_codex_subtask/)
  assert.match(note, /1\. \(Codex\) Build it/)
})
