import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { restoreSnapshot, takeSnapshot } from '../../src/main/git/snapshots'
import { makeProject } from '../support/fixtures'

test('Undo puts files back exactly as they were (same bytes, new files removed)', async () => {
  const dir = makeProject({ 'shop.js': 'line one\nline two\n', 'crlf.txt': 'a\r\nb\r\n' })
  const before = { shop: readFileSync(join(dir, 'shop.js')), crlf: readFileSync(join(dir, 'crlf.txt')) }
  const snapshot = await takeSnapshot(dir, 'before')
  writeFileSync(join(dir, 'shop.js'), 'changed\n')
  writeFileSync(join(dir, 'crlf.txt'), 'changed\r\n')
  writeFileSync(join(dir, 'new.js'), 'new\n')
  const result = await restoreSnapshot(dir, snapshot)
  assert.ok(result.changedFiles.length >= 2, JSON.stringify(result.changedFiles))
  assert.deepEqual(readFileSync(join(dir, 'shop.js')), before.shop, 'shop.js bytes match')
  assert.deepEqual(readFileSync(join(dir, 'crlf.txt')), before.crlf, 'crlf.txt bytes match')
  assert.equal(existsSync(join(dir, 'new.js')), false, 'new file removed')
})

test('Undo of an uncommitted edit made before the snapshot keeps that edit', async () => {
  const dir = makeProject({ 'a.js': 'v1\n' })
  writeFileSync(join(dir, 'a.js'), 'v2 uncommitted\n')
  const snapshot = await takeSnapshot(dir, 'before')
  writeFileSync(join(dir, 'a.js'), 'v3 by the agent\n')
  await restoreSnapshot(dir, snapshot)
  assert.equal(readFileSync(join(dir, 'a.js'), 'utf-8'), 'v2 uncommitted\n')
})
