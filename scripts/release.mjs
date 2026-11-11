// Publishes the packaged version as a GitHub release, with what the in-app updater needs:
//   npm run package && npm run release            (add --draft to check it on GitHub first)
// Uploads release/VibeApp-<version>-setup.exe, its .blockmap and latest.yml (the
// version and SHA-512 the updater checks the download against), with the version's
// CHANGELOG.md section as the notes. Uses the GitHub CLI's own sign-in (gh auth login).
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = join(import.meta.dirname, '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const draft = process.argv.includes('--draft')

const exe = join(root, 'release', `VibeApp-${version}-setup.exe`)
const files = [exe, `${exe}.blockmap`, join(root, 'release', 'latest.yml')]
for (const f of files) {
  if (!existsSync(f)) throw new Error(`Missing ${f}. Run npm run package first.`)
}
// Never upload a build with the wrong things inside.
execFileSync(process.execPath, [join(root, 'scripts', 'check-package.mjs')], { stdio: 'inherit' })
const latest = readFileSync(files[2], 'utf8')
if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(latest)) {
  throw new Error(`release/latest.yml is for another version. Run npm run package again for ${version}.`)
}

// This version's section of the changelog.
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const section = changelog.split(/^## /m).find((part) => part.split(/[\s(]/, 1)[0] === version)
if (!section) throw new Error(`CHANGELOG.md has no "## ${version}" section yet.`)
const notes = [
  section.slice(section.indexOf('\n') + 1).trim(),
  '',
  '## Install',
  '',
  `Already have VibeApp? It offers this update itself (or Settings → Updates → Check for updates).`,
  '',
  `New: download **VibeApp-${version}-setup.exe** below and run it. It isn't code-signed, so Windows SmartScreen will warn you: choose **More info → Run anyway**.`,
  '',
  'Full history: [CHANGELOG.md](https://github.com/mrg1nger/VibeApp/blob/master/CHANGELOG.md)'
].join('\n')
const notesFile = join(mkdtempSync(join(tmpdir(), 'vibeapp-release-')), 'notes.md')
writeFileSync(notesFile, notes)

const args = ['release', 'create', `v${version}`, ...files, '--repo', 'mrg1nger/VibeApp', '--target', 'master', '--title', `VibeApp ${version}`, '--notes-file', notesFile]
if (draft) args.push('--draft')
execFileSync('gh', args, { stdio: 'inherit' })
console.log(`\nReleased v${version}${draft ? ' as a draft (publish it on GitHub when it looks right)' : ''}.`)
