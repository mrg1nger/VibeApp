import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { getLoadablePath } from 'sqlite-vec'
import type { Embedder } from '../../src/main/memory/embedder'
import { conventionsFor, factsForRequest, filesForRequest, findCode, recallFacts, setEmbedderForTests } from '../../src/main/memory/meaning'
import { memoryDb } from '../../src/main/memory/paths'
import { askApp, SEARCH_PIPE_META, type SearchPipeAddress } from '../../src/main/memory/searchClient'
import { startMemorySearch, stopMemorySearch } from '../../src/main/memory/searchPipe'
import {
  comparesVectorsInDatabase,
  deleteFact,
  factsMissingVectors,
  getMeta,
  nearestFacts,
  openMemory,
  rememberFact,
  saveCodeSummaries,
  saveFactVector,
  setMeta,
  updateFact,
  vectorCoverage
} from '../../src/main/memory/store'

// A stand-in for the language model: a text points along the subjects it mentions, so two texts
// about the same subject are alike whatever their words. (The real model is measured in
// tests/eval/search.test.ts.)
const SUBJECTS = [
  ['deploy', 'online', 'publish', 'ship', 'live', 'hosting'],
  ['colour', 'blue', 'theme', 'look', 'style'],
  ['save', 'storage', 'quota', 'progress'],
  ['enemy', 'enemies', 'slime', 'monster', 'monsters']
]

function standIn(model = 'stand-in'): Embedder & { asked: string[] } {
  const asked: string[] = []
  return {
    model,
    asked,
    async embed(text) {
      asked.push(text)
      const v = new Float32Array(SUBJECTS.length + 1)
      const said = text.toLowerCase().match(/[a-z]+/g) ?? []
      SUBJECTS.forEach((subject, i) => {
        v[i] = said.filter((w) => subject.includes(w)).length ? 1 : 0
      })
      // About none of them ("yes please"): its own direction, like nothing remembered.
      if (!v.some(Boolean)) v[SUBJECTS.length] = 1
      const length = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
      return v.map((x) => x / length)
    }
  }
}

const tempDb = (): string => join(mkdtempSync(join(tmpdir(), 'vibeapp-meaning-')), 'memory.db')
const withAddOn = openMemory(tempDb(), getLoadablePath())
const plain = openMemory(tempDb())

test('the sqlite-vec add-on loads, and finds the same nearest facts as plain JavaScript', async () => {
  assert.equal(comparesVectorsInDatabase(withAddOn), true, 'add-on loaded')
  assert.equal(comparesVectorsInDatabase(plain), false)
  const e = standIn()
  const order: string[][] = []
  for (const db of [withAddOn, plain]) {
    rememberFact(db, 'near', 'Ship it with npm run deploy; hosting is on the Hetzner box.', 'user', { category: 'decision' })
    rememberFact(db, 'near', 'The theme is blue and white.', 'user', { category: 'about' })
    rememberFact(db, 'near', 'Slime enemies have 3 hit points.', 'user', { category: 'about' })
    rememberFact(db, 'elsewhere', 'Publish with the hosting dashboard.', 'user', { category: 'decision' })
    for (const fact of factsMissingVectors(db, e.model, null)) saveFactVector(db, e.model, fact, await e.embed(fact.text))
    const near = nearestFacts(db, 'near', e.model, await e.embed('how do I put the game online'), 3)
    assert.match(near[0].fact.text, /npm run deploy/)
    assert.ok(Math.abs(near[0].similarity - 1) < 1e-6, 'the same subject: similarity 1')
    assert.ok(Math.abs(near[1].similarity) < 1e-6, 'another subject: similarity 0')
    assert.equal(near.length, 3, "another project's facts are not searched")
    order.push(near.map((n) => `${n.fact.text} ${n.similarity.toFixed(4)}`).sort())
  }
  assert.deepEqual(order[0], order[1])
})

test('a vector is dropped when its fact changes or goes, and never saved for a text that changed meanwhile', async () => {
  const e = standIn()
  const db = plain
  const { fact } = rememberFact(db, 'drop', 'Progress is kept in browser storage.', 'user', { category: 'about' })
  const other = rememberFact(db, 'drop', 'The look is a dark theme.', 'user', { category: 'about' }).fact
  const missing = (): string[] => factsMissingVectors(db, e.model, ['drop']).map((f) => f.id).sort()
  assert.deepEqual(missing(), [fact.id, other.id].sort())
  for (const f of factsMissingVectors(db, e.model, ['drop'])) saveFactVector(db, e.model, f, await e.embed(f.text))
  assert.deepEqual(missing(), [])
  // Made by another model: counts as missing.
  assert.equal(factsMissingVectors(db, 'a-newer-model', ['drop']).length, 2)

  updateFact(db, fact.id, { text: 'Progress is kept in a save file on the server.' })
  assert.deepEqual(missing(), [fact.id], 'the changed fact needs a new vector')
  // Its vector was being made from the old text: not saved.
  saveFactVector(db, e.model, { id: fact.id, text: 'Progress is kept in browser storage.' }, await e.embed('old'))
  assert.deepEqual(missing(), [fact.id])

  const before = vectorCoverage(db, e.model).factsDone
  deleteFact(db, other.id)
  assert.equal(vectorCoverage(db, e.model).factsDone, before - 1, 'the deleted fact took its vector with it')
})

test('a search finds facts and files by what they mean, and makes missing vectors on the way', async () => {
  const e = standIn()
  setEmbedderForTests(e)
  const db = plain
  rememberFact(db, 'find', 'Ship it with npm run release; hosting is on Netlify.', 'user', { category: 'decision' })
  rememberFact(db, 'find', 'Slime monsters split in two when hit.', 'user', { category: 'about' })
  saveCodeSummaries(db, 'find', [
    { path: 'src/netlify.js', summary: 'Publish the built site to hosting', hash: 'a' },
    { path: 'src/slime.js', summary: 'Enemy movement and splitting', hash: 'b' }
  ])
  // No word in common with the fact or the file.
  const facts = await recallFacts(db, 'find', 'how do I put the game online?')
  assert.match(facts[0].text, /npm run release/)
  const files = await findCode(db, 'find', 'where do the monsters get drawn')
  assert.equal(files[0].path, 'src/slime.js')
  assert.equal(factsMissingVectors(db, e.model, ['find']).length, 0)
  // The same question again is not put through the model a second time.
  const calls = e.asked.length
  await recallFacts(db, 'find', 'how do I put the game online?')
  assert.equal(e.asked.length, calls)
  setEmbedderForTests(undefined)
})

test('an exact name is never lost: the keyword search’s first find stays among the first five', async () => {
  setEmbedderForTests(standIn())
  const db = plain
  for (let i = 1; i <= 7; i++) rememberFact(db, 'exact', `Deploy note ${i}: hosting region ${i} goes live on day ${i}.`, 'user', { category: 'about' })
  const named = rememberFact(db, 'exact', 'QuotaExceededError appears when the progress file passes 5 MB.', 'user', { category: 'gotcha' }).fact
  const found = await recallFacts(db, 'exact', 'QuotaExceededError when I deploy', 6)
  assert.equal(found.length, 6)
  assert.equal(found[4].id, named.id)
  setEmbedderForTests(undefined)
})

test('only what is close in meaning is attached to a request, and never to "yes please"', async () => {
  setEmbedderForTests(standIn())
  const db = plain
  rememberFact(db, 'attach', 'Never publish on a Friday: hosting support is closed.', 'user', { category: 'gotcha' })
  rememberFact(db, 'attach', 'Deploy only from the main branch.', 'user', { category: 'preference', key: true })
  rememberFact(db, 'attach', 'The theme colour is blue.', 'user', { category: 'about' })
  saveCodeSummaries(db, 'attach', [
    { path: 'scripts/ship.js', summary: 'Publish to hosting', hash: 'a' },
    { path: 'src/theme.css', summary: 'Colour and style', hash: 'b' }
  ])
  const facts = await factsForRequest(db, 'attach', 'put the game online please')
  assert.deepEqual(facts.map((f) => f.text), ['Never publish on a Friday: hosting support is closed.'], 'the key fact is in the instructions already')
  assert.deepEqual((await filesForRequest(db, 'attach', 'put the game online please')).map((f) => f.path), ['scripts/ship.js'])
  assert.deepEqual((await conventionsFor(db, 'attach', 'put the game online')).map((f) => f.category), ['gotcha'])
  assert.equal((await conventionsFor(db, 'attach', 'make the look darker')).length, 0, 'an "about" fact is not a convention')
  assert.equal((await factsForRequest(db, 'attach', 'yes please')).length, 0)
  assert.equal((await filesForRequest(db, 'attach', 'ok, try again')).length, 0)

  // Fairly alike (two of the request's three subjects, 0.82): attached only when the keyword pre-fetch picked it too.
  rememberFact(db, 'two-signs', 'The blue monster is the boss.', 'user', { category: 'decision' })
  rememberFact(db, 'two-signs', 'Slime uses the theme palette.', 'user', { category: 'decision' })
  saveCodeSummaries(db, 'two-signs', [
    { path: 'src/boss.js', summary: 'The blue monster boss', hash: 'a' },
    { path: 'src/palette.js', summary: 'Slime theme palette', hash: 'b' }
  ])
  const request = 'ship the blue monster'
  assert.deepEqual((await factsForRequest(db, 'two-signs', request)).map((f) => f.text), ['The blue monster is the boss.'])
  assert.deepEqual((await filesForRequest(db, 'two-signs', request)).map((f) => f.path), ['src/boss.js'])
  assert.deepEqual((await conventionsFor(db, 'two-signs', request)).map((f) => f.text), ['The blue monster is the boss.'])
  setEmbedderForTests(undefined)
})

test('without the model, searches go by keyword as before', async () => {
  setEmbedderForTests(null)
  const db = plain
  rememberFact(db, 'keyword', 'The checkout page posts orders to /api/orders.', 'user', { category: 'decision' })
  assert.match((await recallFacts(db, 'keyword', 'checkout orders'))[0].text, /checkout page/)
  assert.equal((await recallFacts(db, 'keyword', 'paying for things')).length, 0, 'no shared word, no model: nothing')
  assert.equal((await factsForRequest(db, 'keyword', 'change the checkout page orders'))[0]?.category, 'decision')
  setEmbedderForTests(undefined)
})

test("agents' memory tools ask the app over a local pipe; a wrong token gets no answer", async () => {
  setEmbedderForTests(standIn())
  const db = memoryDb()
  const pid = `pipe-${Date.now()}`
  const { fact } = rememberFact(db, pid, 'Ship it with the hosting dashboard.', 'user', { category: 'decision' })
  saveCodeSummaries(db, pid, [{ path: 'src/slime.js', summary: 'Enemy movement', hash: 'a' }])
  assert.equal(await askApp(db, { kind: 'facts', projectId: pid, text: 'put it online', limit: 5 }), null, 'app not listening: keyword search')

  await startMemorySearch()
  try {
    assert.deepEqual(await askApp(db, { kind: 'facts', projectId: pid, text: 'put it online', limit: 5 }), [fact.id])
    assert.deepEqual(await askApp(db, { kind: 'code', projectId: pid, text: 'monsters', limit: 5 }), ['src/slime.js'])
    assert.deepEqual(await askApp(db, { kind: 'facts', projectId: 'another-project', text: 'put it online', limit: 5 }), [])

    const address = JSON.parse(getMeta(db, SEARCH_PIPE_META)!) as SearchPipeAddress
    assert.equal(address.pid, process.pid)
    assert.match(address.path, process.platform === 'win32' ? /^\\\\\.\\pipe\\vibeapp-memory-/ : /vibeapp-memory-.*\.sock$/)
    setMeta(db, SEARCH_PIPE_META, JSON.stringify({ ...address, token: 'f'.repeat(64) }))
    assert.equal(await askApp(db, { kind: 'facts', projectId: pid, text: 'put it online', limit: 5 }), null)
    setMeta(db, SEARCH_PIPE_META, JSON.stringify(address))
  } finally {
    stopMemorySearch()
    setEmbedderForTests(undefined)
  }
  assert.equal(getMeta(db, SEARCH_PIPE_META), null, 'the address is taken down when the app quits')
  assert.equal(await askApp(db, { kind: 'facts', projectId: pid, text: 'put it online', limit: 5 }), null)
})
