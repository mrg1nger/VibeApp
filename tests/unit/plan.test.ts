import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvedPlanFact, approvedPlanNote, looksBig, matchTodosToSteps, parsePlanSteps, planTitle, progressMarkers } from '@shared/plan'

test("a plan is named after its heading or its first sentence, and its fact is one line pointing at it", () => {
  assert.equal(planTitle('# Security review of FNotes\n\nThis was a read-only review.'), 'Security review of FNotes')
  assert.equal(planTitle('\nAdd a sell price to shop.js. Shields sell for half.\n\n## Steps\n1. (Claude) Add it'), 'Add a sell price to shop.js')
  assert.equal(planTitle('1. (claude) Add sellPrice(item) to shop.js\n2. (codex) Write tests'), 'Add sellPrice(item) to shop.js')
  assert.ok(planTitle('x'.repeat(300)).length <= 90)
  assert.equal(planTitle('  \n'), 'Untitled plan')
  assert.equal(
    approvedPlanFact({ id: 3, title: 'Security review of FNotes', approvedAt: '2026-11-10T09:30:00.000Z' }),
    'Approved 2026-11-10: Security review of FNotes (plan #3, full text in the plans memory tool).'
  )
})

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

test("Claude's to-do list counts as progress on the plan steps", () => {
  const steps = parsePlanSteps('## Steps\n1. Add sellPrice to shop.js\n2. Write tests in shop.test.js\n3. Update the README')
  // Same number of items: one each, in order.
  assert.deepEqual(
    matchTodosToSteps(
      [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' }
      ],
      steps
    ),
    ['done', 'doing', undefined]
  )
  // Different number: matched by shared words.
  assert.deepEqual(
    matchTodosToSteps(
      [
        { content: 'Write the shop.test.js tests', status: 'in_progress' },
        { content: 'Add sellPrice to shop.js', status: 'completed' }
      ],
      steps
    ),
    ['done', 'doing', undefined]
  )
})

test('STEP markers are read from what Codex says', () => {
  assert.deepEqual(progressMarkers('ok\nSTEP 1: doing\nworking...\nSTEP 1: done\nstep 2 - doing'), [
    { step: 1, status: 'doing' },
    { step: 1, status: 'done' },
    { step: 2, status: 'doing' }
  ])
  assert.deepEqual(progressMarkers('No steps mentioned here, just step 3 of the work.'), [])
})

test('big requests are noticed; small ones are not', () => {
  assert.equal(looksBig('Fix the typo on the home page'), false)
  assert.equal(looksBig('Please:\n- add login\n- add signup\n- add a profile page\n- add settings'), true)
  assert.equal(looksBig('x'.repeat(701)), true)
})
