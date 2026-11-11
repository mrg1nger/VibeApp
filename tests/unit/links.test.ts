import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { changesSince, takeSnapshot } from '../../src/main/git/snapshots'
import { setHelperJobForTests, type HelperJob } from '../../src/main/helpers/helperJob'
import { noteRequestChanges } from '../../src/main/memory/links'
import { memoryDb } from '../../src/main/memory/paths'
import { runScribe } from '../../src/main/memory/scribe'
import { tidyMemory } from '../../src/main/memory/tidy'
import {
  addMessage,
  getFact,
  keyFactsBlock,
  linkFactFiles,
  linkNamedFiles,
  listFacts,
  namedFiles,
  noteFileChanges,
  outdatedNotes,
  possiblyOutdatedFacts,
  rememberFact,
  unusedFacts,
  updateFact
} from '../../src/main/memory/store'
import { makeProject } from '../support/fixtures'

// Memory that knows when it may be old: facts are linked to the files they are about, every
// request's changes are counted against them, and the tidy-up checks the ones whose files
// changed a lot (or are gone) and retires facts nobody looks up.

after(() => setHelperJobForTests(undefined))

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n'

test('a fact names a file by its path, or by a file name only one mapped file has', () => {
  const paths = ['src/player.js', 'src/enemy/slime.js', 'src/index.js', 'tests/index.js', 'README.md']
  assert.deepEqual(namedFiles('Movement lives in src/player.js.', paths), ['src/player.js'])
  assert.deepEqual(namedFiles('Slimes split in slime.js when hit', paths), ['src/enemy/slime.js'])
  assert.deepEqual(namedFiles('Windows paths count too: src\\player.js', paths), ['src/player.js'])
  assert.deepEqual(namedFiles('The entry point is index.js', paths), [], 'two files are called index.js')
  assert.deepEqual(namedFiles('player.jsx and myplayer.js are other files', paths), [])
  assert.deepEqual(namedFiles('Documented in README.md', paths), ['README.md'])
})

test('a fact whose file changed by about its own length, or is gone, may be out of date', () => {
  const db = memoryDb()
  const fact = rememberFact(db, 'p-links', 'Slimes split in two when hit, in src/slime.js.', 'user', { category: 'decision' }).fact
  linkFactFiles(db, fact.id, [{ path: 'src/slime.js', lines: 50 }])
  assert.equal(outdatedNotes(db, [fact.id]).size, 0, 'just linked')

  noteFileChanges(db, 'p-links', [{ path: 'src/slime.js', added: 20, removed: 10 }], [])
  assert.equal(outdatedNotes(db, [fact.id]).size, 0, '30 of 50 lines is not a lot yet')
  noteFileChanges(db, 'another-project', [{ path: 'src/slime.js', added: 100, removed: 100 }], [])
  assert.equal(outdatedNotes(db, [fact.id]).size, 0, "another project's file of the same name doesn't count")
  noteFileChanges(db, 'p-links', [{ path: 'src/slime.js', added: 15, removed: 5 }], [])
  assert.equal(outdatedNotes(db, [fact.id]).get(fact.id), 'src/slime.js has changed a lot since (50 lines)')

  // Everywhere the fact is shown: the Memory screen and the key facts in every request.
  const listed = listFacts(db, 'p-links').find((f) => f.id === fact.id)!
  assert.deepEqual(listed.files, ['src/slime.js'])
  assert.match(listed.mayBeOutdated!, /changed a lot/)
  updateFact(db, fact.id, { key: true })
  assert.match(keyFactsBlock(db, 'p-links'), /Slimes split .*\[may be out of date: src\/slime\.js has changed a lot since/)

  // Said again in new words: it is up to date again.
  updateFact(db, fact.id, { text: 'Slimes split in three when hit, in src/slime.js.' })
  assert.equal(outdatedNotes(db, [fact.id]).size, 0)

  noteFileChanges(db, 'p-links', [], ['src/slime.js'])
  assert.equal(outdatedNotes(db, [fact.id]).get(fact.id), 'src/slime.js is gone')
  updateFact(db, fact.id, { text: 'Slimes no longer split.' })
  assert.deepEqual(listFacts(db, 'p-links').find((f) => f.id === fact.id)!.files, [], 'a link to a deleted file goes when the fact is reworded')
})

test('a small file needs a few changed lines before its facts count as possibly out of date', () => {
  const db = memoryDb()
  const fact = rememberFact(db, 'p-small', 'The version is read from version.txt.', 'user', { category: 'setup' }).fact
  linkFactFiles(db, fact.id, [{ path: 'version.txt', lines: 1 }])
  noteFileChanges(db, 'p-small', [{ path: 'version.txt', added: 1, removed: 1 }], [])
  assert.equal(outdatedNotes(db, [fact.id]).size, 0, 'bumping a one-line file is not a rewrite')
})

test("facts are linked to the mapped files they name, once, without resetting what's counted", () => {
  const db = memoryDb()
  const fact = rememberFact(db, 'p-named', 'Prices live in shop.js; the battle formula in src/battle.js.', 'user', { category: 'about' }).fact
  const other = rememberFact(db, 'p-named', 'The game is turn based.', 'user', { category: 'about' }).fact
  assert.equal(linkNamedFiles(db, 'p-named', ['shop.js', 'src/battle.js', 'src/map.js'], () => 40), 2)
  noteFileChanges(db, 'p-named', [{ path: 'shop.js', added: 30, removed: 30 }], [])
  assert.equal(linkNamedFiles(db, 'p-named', ['shop.js', 'src/battle.js', 'src/map.js'], () => 40), 0, 'already linked')
  assert.equal(outdatedNotes(db, [fact.id]).get(fact.id), 'shop.js has changed a lot since (60 lines)')
  assert.deepEqual(listFacts(db, 'p-named').find((f) => f.id === other.id)!.files, [])
})

test("what a request changed is read from its snapshot: lines per file, and the files it deleted", async () => {
  const dir = makeProject({ 'a.js': lines(10), 'b.js': lines(5), 'package-lock.json': '{}\n' })
  const snapshot = await takeSnapshot(dir, 'before')
  writeFileSync(join(dir, 'a.js'), lines(4))
  writeFileSync(join(dir, 'c.js'), lines(3))
  writeFileSync(join(dir, 'package-lock.json'), '{"changed": true}\n')
  rmSync(join(dir, 'b.js'))
  const { changes, gone } = await changesSince(dir, snapshot)
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c.added + c.removed]))
  assert.deepEqual(byPath, { 'a.js': 6, 'b.js': 5, 'c.js': 3 }, 'lockfiles left out')
  assert.deepEqual(gone, ['b.js'])

  // The end of a request: counted against the facts about those files.
  const db = memoryDb()
  const fact = rememberFact(db, 'p-request', 'Helpers are in b.js.', 'user', { category: 'about' }).fact
  const before = rememberFact(db, 'p-request', 'a.js holds the ten levels.', 'user', { category: 'about' }).fact
  linkFactFiles(db, fact.id, [{ path: 'b.js', lines: 5 }])
  linkFactFiles(db, before.id, [{ path: 'a.js', lines: 10 }])
  db.prepare('UPDATE facts SET updated_at = ? WHERE id IN (?, ?)').run('2020-01-01T00:00:00.000Z', fact.id, before.id)
  // Corrected by an agent during the request: it already describes a.js after it.
  const during = rememberFact(db, 'p-request', 'a.js holds four levels now.', 'claude', { category: 'about' }).fact
  linkFactFiles(db, during.id, [{ path: 'a.js', lines: 1 }])
  assert.deepEqual((await noteRequestChanges('p-request', dir, snapshot)).sort(), ['a.js', 'c.js'])
  assert.equal(outdatedNotes(db, [fact.id]).get(fact.id), 'b.js is gone')
  const churn = (id: string): number => (db.prepare('SELECT churn FROM fact_files WHERE fact_id = ?').get(id) as { churn: number }).churn
  assert.equal(churn(before.id), 6, 'saved before the request: counted')
  assert.equal(churn(during.id), 0, 'saved during the request: not counted')
  assert.deepEqual(await noteRequestChanges('p-request', dir, undefined), [], 'no snapshot, nothing counted')
})

test('the note-taker links what it saves to the files the request changed, and says which fact replaced which', async () => {
  const dir = makeProject({ 'src/save.js': lines(30), 'src/hud.js': lines(10) })
  const db = memoryDb()
  const old = rememberFact(db, 'p-scribe', 'Progress is saved under the key save-v1.', 'user', { category: 'decision' }).fact
  linkFactFiles(db, old.id, [{ path: 'src/save.js', lines: 30 }])
  const prompts: string[] = []
  setHelperJobForTests(async (job: HelperJob) => {
    prompts.push(job.prompt)
    return {
      text: '',
      by: 'haiku',
      structured: {
        add: [
          {
            text: 'The HUD shows the coin count top right.',
            category: 'decision',
            key: false,
            global: false,
            // One it may name, one the request didn't change.
            files: ['src/hud.js', 'src/other.js'],
            standing: false
          }
        ],
        update: [{ id: old.id, text: 'Progress is saved under the key save-v2.', files: ['src/save.js'] }],
        forget: []
      }
    }
  })
  const result = await runScribe('p-scribe', {
    request: 'Move saves to save-v2 and show coins on the HUD.',
    replies: ['Done: saves now use save-v2, and the HUD shows coins top right.'],
    actions: ['Edited src/save.js', 'Edited src/hud.js'],
    stopped: false,
    hadError: false,
    files: ['src/save.js', 'src/hud.js'],
    projectPath: dir
  })
  setHelperJobForTests(undefined)
  assert.deepEqual(result, { added: 1, updated: 1, forgotten: 0 })
  assert.match(prompts[0], /FILES CHANGED:\nsrc\/save\.js\nsrc\/hud\.js/)

  const facts = listFacts(db, 'p-scribe')
  const hud = facts.find((f) => /HUD/.test(f.text))!
  const saved = facts.find((f) => /save-v2/.test(f.text))!
  assert.deepEqual(hud.files, ['src/hud.js'])
  assert.deepEqual(saved.files, ['src/save.js'])
  const replaced = getFact(db, old.id)!
  assert.ok(replaced.forgottenAt)
  assert.equal(replaced.replacedBy, saved.id)
})

test('the note-taker is told which known facts may be out of date', async () => {
  const db = memoryDb()
  const fact = rememberFact(db, 'p-scribe-old', 'The map is drawn in map.js.', 'user', { category: 'about', key: true }).fact
  linkFactFiles(db, fact.id, [{ path: 'map.js', lines: 10 }])
  noteFileChanges(db, 'p-scribe-old', [], ['map.js'])
  let prompt = ''
  setHelperJobForTests(async (job) => {
    prompt = job.prompt
    return { text: '', by: 'haiku', structured: { add: [], update: [], forget: [] } }
  })
  await runScribe('p-scribe-old', { request: 'Where is the map drawn now?', replies: ['In world.js.'], actions: [], stopped: false, hadError: false })
  setHelperJobForTests(undefined)
  assert.match(prompt, new RegExp(`\\[${fact.id}\\] \\(about\\) The map is drawn in map\\.js\\. \\[may be out of date: map\\.js is gone\\]`))
})

test('the tidy-up checks facts that may be out of date first: retires what is no longer true, keeps the rest as up to date', async () => {
  const db = memoryDb()
  const scope = 'p-tidy'
  for (let i = 0; i < 3; i++) rememberFact(db, scope, `Ordinary fact number ${i} about the menus.`, 'user', { category: 'other' })
  const stale = rememberFact(db, scope, 'Enemies are drawn in enemies.js.', 'user', { category: 'about' }).fact
  const fine = rememberFact(db, scope, 'Shop prices are in gold.', 'user', { category: 'decision' }).fact
  const newer = rememberFact(db, scope, 'Enemies are drawn by the sprite system in sprites.js.', 'user', { category: 'about' }).fact
  linkFactFiles(db, stale.id, [{ path: 'enemies.js', lines: 40 }])
  linkFactFiles(db, fine.id, [{ path: 'shop.js', lines: 40 }])
  noteFileChanges(db, scope, [{ path: 'shop.js', added: 30, removed: 30 }], ['enemies.js'])
  assert.equal(possiblyOutdatedFacts(db, scope).length, 2)

  let prompt = ''
  setHelperJobForTests(async (job) => {
    prompt = job.prompt
    return { text: '', by: 'haiku', structured: { facts: [], merges: [], outdated: [{ id: stale.id, reason: 'enemies.js is gone', replacedBy: newer.id }] } }
  })
  const result = await tidyMemory(scope)
  setHelperJobForTests(undefined)

  // Both are shown first, with why, and the check is explained.
  const order = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(new Set(order.slice(0, 2)), new Set([stale.id, fine.id]))
  assert.match(prompt, /"mayBeOutdated":"enemies\.js is gone"/)
  assert.match(prompt, /4\. Facts marked mayBeOutdated/)

  assert.equal(result.outdated, 1)
  assert.equal(result.checked, 1)
  assert.equal(getFact(db, stale.id)!.replacedBy, newer.id)
  assert.equal(outdatedNotes(db, [fine.id]).size, 0, 'checked and kept: up to date again')
  assert.equal(possiblyOutdatedFacts(db, scope).length, 0)
})

test('the tidy-up asks nothing extra when no fact may be out of date', async () => {
  const db = memoryDb()
  rememberFact(db, 'p-tidy-plain', 'A plain fact.', 'user', { category: 'other' })
  let prompt = ''
  setHelperJobForTests(async (job) => {
    prompt = job.prompt
    return { text: '', by: 'haiku', structured: { facts: [], merges: [], outdated: [] } }
  })
  const result = await tidyMemory('p-tidy-plain')
  setHelperJobForTests(undefined)
  assert.doesNotMatch(prompt, /mayBeOutdated/)
  assert.deepEqual(result, { categorized: 0, merged: 0, outdated: 0, unused: 0, checked: 0 })
})

test('a fact nobody looked up for 60 days of real use is retired; key facts and quiet projects keep theirs', async () => {
  const db = memoryDb()
  const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const age = (id: string): void => void db.prepare('UPDATE facts SET updated_at = ?, last_used_at = NULL WHERE id = ?').run(old, id)
  const busy = 'p-unused'
  const unused = rememberFact(db, busy, 'The old splash screen fades in over two seconds.', 'user', { category: 'other' }).fact
  const key = rememberFact(db, busy, 'The game is a platformer.', 'user', { category: 'about' }).fact
  const looked = rememberFact(db, busy, 'Levels are stored as JSON.', 'user', { category: 'decision' }).fact
  for (const f of [unused, key, looked]) age(f.id)
  db.prepare('UPDATE facts SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), looked.id)
  for (let i = 0; i < 30; i++) addMessage(db, busy, 'user', `request ${i}`)

  const quiet = 'p-unused-quiet'
  const resting = rememberFact(db, quiet, 'The quiet project uses tabs.', 'user', { category: 'other' }).fact
  age(resting.id)
  for (let i = 0; i < 29; i++) addMessage(db, quiet, 'user', `request ${i}`)

  assert.deepEqual(unusedFacts(db, busy).map((f) => f.id), [unused.id])
  assert.deepEqual(unusedFacts(db, quiet), [], '29 requests in 90 days: the project was hardly used')

  setHelperJobForTests(async () => ({ text: '', by: 'haiku', structured: { facts: [], merges: [], outdated: [] } }))
  const result = await tidyMemory(busy)
  setHelperJobForTests(undefined)
  assert.equal(result.unused, 1)
  assert.match(getFact(db, unused.id)!.forgottenReason!, /not looked up in over 60 days/)
  assert.equal(getFact(db, key.id)!.forgottenAt, null)
})
