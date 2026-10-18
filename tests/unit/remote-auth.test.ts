import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import {
  checkRemoteCall,
  deviceForToken,
  listDevices,
  pair,
  pairingCode,
  PairingError,
  revokeDevice,
  rotatePairingCode
} from '../../src/main/remote/auth'

test('pairing with the right code gives a working token, and the code is then replaced', () => {
  const code = pairingCode()
  const { token, device } = pair(code, 'Test browser', '10.0.0.1', false)
  assert.ok(token.length >= 40)
  assert.equal(deviceForToken(token)?.id, device.id)
  assert.notEqual(pairingCode(), code, 'a code works once')
  assert.throws(() => pair(code, 'Second', '10.0.0.1', false), PairingError)
  assert.equal(deviceForToken('not-a-token'), null)
  assert.equal(deviceForToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), null)
})

test('wrong codes are refused, and an address is locked out after five', () => {
  const address = '10.0.0.99'
  for (let i = 0; i < 5; i++) {
    assert.throws(() => pair('000000x', 'x', address, false), (err: PairingError) => err.status === 401)
  }
  // Even the right code is refused while locked out...
  assert.throws(() => pair(pairingCode(), 'x', address, false), (err: PairingError) => err.status === 429)
  // ...but other addresses are unaffected.
  const ok = pair(pairingCode(), 'Other', '10.0.0.100', false)
  assert.ok(ok.token)
})

test('revoking a device stops its token working', () => {
  const { token, device } = pair(pairingCode(), 'To revoke', '10.0.0.2', false)
  revokeDevice(device.id)
  assert.equal(deviceForToken(token), null)
  assert.ok(!listDevices().some((d) => d.id === device.id))
})

test('a new pairing code can be made at any time', () => {
  const before = pairingCode()
  assert.notEqual(rotatePairingCode(), before)
  assert.match(pairingCode(), /^\d{6}$/)
})

test('read-only connections can only read; remote settings stay on the computer', () => {
  assert.equal(checkRemoteCall('vibe:project:list', [], true).allowed, true)
  assert.equal(checkRemoteCall('vibe:chat:loadTranscript', ['p'], true).allowed, true)
  assert.equal(checkRemoteCall('vibe:chat:send', ['p', 'path', 'hi'], true).allowed, false)
  assert.equal(checkRemoteCall('vibe:secrets:set', ['p', 'K', 'v'], true).allowed, false)
  assert.equal(checkRemoteCall('vibe:chat:send', ['p', 'path', 'hi'], false).allowed, true)
  // Never from a remote device, read-only or not:
  for (const channel of ['vibe:remote:revokeAll', 'vibe:remote:apply', 'vibe:remote:status', 'vibe:remote:rotateCode']) {
    assert.equal(checkRemoteCall(channel, [], false).allowed, false, channel)
  }
  assert.equal(checkRemoteCall('vibe:remote:previewUrl', ['p'], false).allowed, true)
  const settings = checkRemoteCall('vibe:settings:update', [{ remoteAccess: 'lan', remoteReadOnly: false, autoAsk: false }], false)
  assert.deepEqual(settings.args, [{ autoAsk: false }], 'remote-access keys are stripped')
})

test('a device that was not remembered lapses after 12 hours unused; a remembered one does not', () => {
  const temp = pair(pairingCode(), 'Borrowed', '10.0.0.3', false, false)
  const kept = pair(pairingCode(), 'Mine', '10.0.0.4', false, true)
  assert.equal(temp.device.remember, false)
  assert.equal(kept.device.remember, true)
  // Pretend both were last used 13 hours ago.
  const file = join(app.getPath('userData'), 'remote.json')
  const data = JSON.parse(readFileSync(file, 'utf-8'))
  const old = new Date(Date.now() - 13 * 60 * 60_000).toISOString()
  for (const d of data.devices) if ([temp.device.id, kept.device.id].includes(d.id)) d.lastSeen = old
  writeFileSync(file, JSON.stringify(data))
  assert.equal(deviceForToken(temp.token), null, 'the borrowed browser has lapsed')
  assert.equal(deviceForToken(kept.token)?.id, kept.device.id, 'the remembered one still works')
  assert.ok(!listDevices().some((d) => d.id === temp.device.id), 'and it is gone from the list')
})
