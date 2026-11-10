import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { grounded } from '../../src/main/memory/scribe'
import {
  codeSummariesFor,
  keyFactsBlock,
  listFacts,
  openMemory,
  rememberFact,
  reviewConventions,
  saveCodeSummaries
} from '../../src/main/memory/store'
import { addTalkMessage, historyText } from '../../src/main/chat/talkStore'
import {
  activeExtensions,
  addExtension,
  listExtensions,
  removeExtension,
  setExtensionEnv
} from '../../src/main/extensions/store'

const db = openMemory(join(mkdtempSync(join(tmpdir(), 'vibeapp-unit-')), 'memory.db'))

test('facts may only state numbers the exchange actually contained', () => {
  const evidence = 'The server runs on port 3000 behind nginx.'
  assert.equal(grounded('The server runs on port 3000.', evidence), 'The server runs on port 3000.')
  assert.equal(grounded('The dev server uses port 5173.', evidence), null)
  assert.equal(grounded('The app uses nginx (on port 8080).', evidence), 'The app uses nginx.')
})

test('plan facts saved with their s taken out are forgotten; real ones stay', async () => {
  const { forgetDamagedPlanFacts } = await import('../../src/main/memory/store')
  const damaged = rememberFact(db, 'p-plan', 'Plan the user approved: # Overview of fab ticky / FNote Thi reque t wa ju t to look over the project — no change needed.', 'user', { category: 'decision' })
  const fine = rememberFact(db, 'p-plan', 'Plan the user approved: # Add a sell price. Shields sell for half; tests check every item in the shop.', 'user', { category: 'decision' })
  assert.equal(forgetDamagedPlanFacts(db), 1)
  const left = listFacts(db, 'p-plan').map((f) => f.id)
  assert.ok(!left.includes(damaged.fact.id), 'damaged one forgotten')
  assert.ok(left.includes(fine.fact.id), 'good one kept')
})

test('a near-duplicate fact updates the old one instead of adding a second', () => {
  rememberFact(db, 'p1', 'The game uses a canvas renderer for the map.', 'user', { category: 'about' })
  const result = rememberFact(db, 'p1', 'The game uses a canvas renderer for the map view.', 'user', { category: 'about' })
  assert.ok(result.mergedInto, 'merged')
  assert.equal(listFacts(db, 'p1').length, 1)
})

test('review conventions surface related rules but not unrelated ones', () => {
  rememberFact(db, 'p2', 'Never call the orders API from the cart code; go through the checkout service.', 'user', { category: 'gotcha' })
  rememberFact(db, 'p2', 'The project uses a blue and white colour scheme.', 'user', { category: 'about' })
  const related = reviewConventions(db, 'p2', 'add a discount code to the cart src/cart.js')
  assert.equal(related.length, 1)
  assert.match(related[0].text, /orders API/)
  assert.equal(reviewConventions(db, 'p2', 'rename the logo file').length, 0)
})

test('key facts and code map lookups', () => {
  rememberFact(db, 'p3', 'Never touch public/battle.js.', 'user', { category: 'preference', key: true })
  assert.match(keyFactsBlock(db, 'p3'), /battle\.js/)
  saveCodeSummaries(db, 'p3', [{ path: 'src/a.js', summary: 'Player movement', hash: 'x' }])
  assert.deepEqual([...codeSummariesFor(db, 'p3', ['src/a.js', 'missing.js'])], [['src/a.js', 'Player movement']])
})

test('the Chat tab replays the latest messages within its budget, labelled by agent', () => {
  const id = 'aaaaaaaa-1111-2222-3333-444444444444'
  addTalkMessage(id, { role: 'user', text: 'My favourite number is 7.' })
  addTalkMessage(id, { role: 'assistant', text: 'OK', agent: 'claude' })
  const c = addTalkMessage(id, { role: 'user', text: 'What is it?' })
  const history = historyText(c)
  assert.match(history, /Assistant \(Claude\): OK/)
  assert.ok(history.endsWith('User: What is it?'))
  assert.ok(historyText(c, 30).includes('What is it?'), 'always keeps the newest message')
})

test('an extension that needs keys stays off until they are supplied', () => {
  const ext = addExtension({ name: 'Weather', command: 'npx', args: ['-y', 'weather-mcp'], env: {}, needsKeys: ['WEATHER_KEY'], enabled: false })
  assert.equal(ext.enabled, false)
  assert.deepEqual(ext.needsKeys, ['WEATHER_KEY'])
  setExtensionEnv(ext.id, { WEATHER_KEY: 'abc' })
  const after = listExtensions().find((e) => e.id === ext.id)!
  assert.equal(after.enabled, true)
  assert.deepEqual(after.needsKeys, [])
  const active = activeExtensions().find((e) => e.server === `ext_${ext.id}`)!
  assert.equal(active.env.WEATHER_KEY, 'abc')
  if (process.platform === 'win32') assert.deepEqual(active.command, 'cmd', 'npx is started through cmd on Windows')
  removeExtension(ext.id)
  assert.equal(listExtensions().some((e) => e.id === ext.id), false)
})
