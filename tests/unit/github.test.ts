import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { githubDanger } from '../../src/main/orchestrator/githubGuard'
import { BehindError, getLatest, githubUrl, parseRepo, syncStatus, uploadToGitHub, useGitHubVersion } from '../../src/main/github/github'
import { checkpoint, ensureRepo } from '../../src/main/git/repo'

test("Claude can't wreck the GitHub account: deleting, changing visibility, reading the sign-in", () => {
  const blocked = [
    'gh repo delete me/shop --yes',
    '"C:\\Program Files\\GitHub CLI\\gh.exe" repo delete me/shop',
    'cd x && gh release delete v1 -y',
    'gh repo edit me/shop --visibility public --accept-visibility-change-consequences',
    'gh repo archive me/shop',
    'gh auth token',
    'gh auth status --show-token',
    'gh auth logout -h github.com',
    'gh api -X DELETE repos/me/shop',
    'gh api --method=DELETE repos/me/shop',
    'gh api repos/me/shop -X PATCH -F private=false',
    'gh secret set TOKEN --body x',
    'git credential fill',
    'git push origin --delete main',
    'git push origin :main',
    'git push --mirror'
  ]
  for (const command of blocked) assert.ok(githubDanger(command), `should block: ${command}`)
  const fine = [
    'gh repo create shop --private --source . --push',
    'gh issue list',
    'gh pr create --fill',
    'gh auth status',
    'gh api repos/me/shop/issues',
    'git push -u origin HEAD',
    'git push origin main',
    'ghost delete',
    'npm run delete-cache',
    'git log --oneline'
  ]
  for (const command of fine) assert.equal(githubDanger(command), null, `should allow: ${command}`)
})

test('repositories typed or picked: owner/name or a github.com address', () => {
  assert.equal(parseRepo('me/shop'), 'me/shop')
  assert.equal(parseRepo('https://github.com/me/shop.git'), 'me/shop')
  assert.equal(parseRepo('git@github.com:me/my.site'), 'me/my.site')
  assert.equal(parseRepo('https://github.com/me/shop/'), 'me/shop')
  assert.equal(parseRepo('me'), null)
  assert.equal(parseRepo('me/../x'), null)
  assert.equal(parseRepo('https://evil.com/me/shop'), null)
})

// Two "computers" (folders) sharing a stand-in for GitHub (a bare repository on disk,
// reached through the GitHub address the way the real one would be).
const root = mkdtempSync(join(tmpdir(), 'vibeapp-github-'))
const hub = join(root, 'hub.git')
const GH_URL = 'https://github.com/me/shop'
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

function linkToHub(dir: string): void {
  git(dir, 'config', `url.${pathToFileURL(hub).href}.insteadOf`, GH_URL)
  git(dir, 'config', 'core.autocrlf', 'false')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
}

const a = join(root, 'computer-a', 'shop')
const b = join(root, 'computer-b', 'shop')

test('back up to GitHub, and the other computer sees the newer work and gets it', async () => {
  execFileSync('git', ['init', '--bare', '-b', 'main', hub])
  mkdirSync(a, { recursive: true })
  await ensureRepo(a) // as VibeApp makes a project: a first checkpoint
  git(a, 'branch', '-M', 'main')
  linkToHub(a)
  writeFileSync(join(a, 'a.txt'), 'one\n')
  git(a, 'remote', 'add', 'origin', GH_URL)
  assert.equal(await githubUrl(a), GH_URL)

  assert.equal(await uploadToGitHub('pa', a, 'Backup: first'), true)
  assert.equal(await uploadToGitHub('pa', a, 'Backup: again'), false, 'nothing new to upload')
  assert.equal((await syncStatus('pa', a)).ahead, 0)

  // The other computer downloads it.
  mkdirSync(join(root, 'computer-b'), { recursive: true })
  execFileSync('git', ['-c', `url.${pathToFileURL(hub).href}.insteadOf=${GH_URL}`, '-c', 'core.autocrlf=false', 'clone', GH_URL, b])
  linkToHub(b)
  assert.equal(readFileSync(join(b, 'a.txt'), 'utf-8'), 'one\n')

  // A carries on; B hears about it.
  writeFileSync(join(a, 'a.txt'), 'one\ntwo\n')
  await uploadToGitHub('pa', a, 'Backup: add two')
  const seen = await syncStatus('pb', b)
  assert.equal(seen.linked, true)
  assert.equal(seen.behind, 1)
  assert.deepEqual(seen.incoming, ['Backup: add two'])
  const got = await getLatest('pb', b)
  assert.deepEqual(got, { status: 'updated', count: 1, merged: false })
  assert.equal(readFileSync(join(b, 'a.txt'), 'utf-8'), 'one\ntwo\n')
  assert.deepEqual(await getLatest('pb', b), { status: 'up_to_date' })
})

test("both computers changed different files: combined, and B's unsaved work is kept", async () => {
  writeFileSync(join(a, 'a.txt'), 'one\ntwo\nthree\n')
  await uploadToGitHub('pa', a, 'Backup: add three')
  writeFileSync(join(b, 'b.txt'), "B's work\n") // not in a checkpoint yet
  const seen = await syncStatus('pb', b)
  assert.equal(seen.behind, 1)
  assert.equal(seen.dirty, true)
  const got = await getLatest('pb', b)
  assert.deepEqual(got, { status: 'updated', count: 1, merged: true })
  assert.equal(readFileSync(join(b, 'a.txt'), 'utf-8'), 'one\ntwo\nthree\n')
  assert.equal(readFileSync(join(b, 'b.txt'), 'utf-8'), "B's work\n")
  assert.equal(await uploadToGitHub('pb', b, 'Backup: combined'), true, 'the combined work goes up')
  await getLatest('pa', a)
  assert.equal(readFileSync(join(a, 'b.txt'), 'utf-8'), "B's work\n")
})

test('both changed the same line: B is told, nothing changes until it chooses; "Use GitHub\'s" keeps B\'s on a branch', async () => {
  writeFileSync(join(a, 'a.txt'), 'one\ntwo\nTHREE from A\n')
  await uploadToGitHub('pa', a, 'Backup: A edits three')
  writeFileSync(join(b, 'a.txt'), 'one\ntwo\nthree from B\n')
  await checkpoint(b, 'B edits three')
  await assert.rejects(uploadToGitHub('pb', b, 'Backup: B'), (err) => err instanceof BehindError)

  const got = await getLatest('pb', b)
  assert.deepEqual(got, { status: 'conflict', files: ['a.txt'] })
  assert.equal(readFileSync(join(b, 'a.txt'), 'utf-8'), 'one\ntwo\nthree from B\n', "B's file untouched")
  assert.ok(!existsSync(join(b, '.git', 'MERGE_HEAD')), 'no half-done merge left behind')

  const { keptAs } = await useGitHubVersion('pb', b)
  assert.equal(readFileSync(join(b, 'a.txt'), 'utf-8'), 'one\ntwo\nTHREE from A\n')
  assert.equal(git(b, 'show', `${keptAs}:a.txt`), 'one\ntwo\nthree from B')
  assert.ok(git(hub, 'branch', '--list', keptAs), "B's version is on GitHub too")
  assert.equal((await syncStatus('pb', b)).behind, 0)
})

test('a backup never uploads a secret key', async () => {
  writeFileSync(join(a, 'config.js'), `const key = "ghp_${'a1B2c3D4e5'.repeat(4)}"\n`)
  await assert.rejects(uploadToGitHub('pa', a, 'Backup: key'), /secret keys/)
  assert.equal(git(hub, 'log', '-1', '--format=%s', 'main'), git(a, 'log', '-1', '--format=%s', 'origin/main'), 'nothing went up')
  rmSync(root, { recursive: true, force: true })
})
