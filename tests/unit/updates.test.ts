import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UpdateState } from '@shared/types'
import { bannerWanted, isNewer } from '@shared/update'
import { installUpdate, releaseUrlFor } from '../../src/main/updates/updates'
import { checkRemoteCall } from '../../src/main/remote/auth'

test('versions compare as numbers, and a pre-release is older than its release', () => {
  assert.equal(isNewer('0.3.2', '0.3.1'), true)
  assert.equal(isNewer('0.10.0', '0.9.9'), true, 'not compared as text')
  assert.equal(isNewer('1.0.0', '0.99.99'), true)
  assert.equal(isNewer('v0.4.0', '0.3.1'), true, 'a leading v is fine')
  assert.equal(isNewer('0.3.1', '0.3.1'), false)
  assert.equal(isNewer('0.3.0', '0.3.1'), false)
  assert.equal(isNewer('0.4.0', '0.4.0-beta.1'), true)
  assert.equal(isNewer('0.4.0-beta.1', '0.4.0'), false)
})

test('the banner shows for a newer version that was not skipped', () => {
  const s: UpdateState = { status: 'available', current: '0.3.1', version: '0.4.0', releasesUrl: '', canInstall: true }
  assert.equal(bannerWanted(s, null), true)
  assert.equal(bannerWanted(s, '0.4.0'), false, 'skipped')
  assert.equal(bannerWanted(s, '0.3.5'), true, 'an older skip does not hide a newer version')
  assert.equal(bannerWanted({ ...s, version: '0.3.1' }, null), false, 'the same version')
  assert.equal(bannerWanted({ ...s, status: 'none' }, null), false)
  assert.equal(bannerWanted({ ...s, status: 'downloading' }, null), true, 'stays up while downloading')
  assert.equal(releaseUrlFor('0.4.0'), 'https://github.com/mrg1nger/VibeApp/releases/tag/v0.4.0')
})

test("updating is refused while a project is working, and says which", async () => {
  await assert.rejects(installUpdate(['My Game']), /My Game is still working/)
  await assert.rejects(installUpdate(['A', 'B']), /A, B are still working/)
})

test('a remote device can see an update but not install it', () => {
  assert.equal(checkRemoteCall('vibe:update:state', [], true).allowed, true)
  assert.equal(checkRemoteCall('vibe:update:check', [], false).allowed, true)
  const install = checkRemoteCall('vibe:update:install', [true], false)
  assert.equal(install.allowed, false)
  assert.match(install.reason ?? '', /computer running VibeApp/)
})
