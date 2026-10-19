import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { withBrowserFixes } from '../../src/main/extensions/store'

test('Playwright gets a fresh profile and keeps its files out of the project', () => {
  const args = withBrowserFixes(['-y', '@playwright/mcp@latest', '--headless'])
  assert.ok(args.includes('--isolated'))
  const out = args[args.indexOf('--output-dir') + 1]
  assert.match(out, /vibeapp-playwright$/)
  assert.ok(!out.includes('\\'), 'forward slashes, so it survives being put in a Codex setting')
})

test('Playwright uses Edge when Chrome is missing, and leaves a chosen browser alone', { skip: process.platform !== 'win32' }, () => {
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
  const has = (p: string): boolean => roots.some((r) => !!r && existsSync(join(r, p)))
  const chrome = has(join('Google', 'Chrome', 'Application', 'chrome.exe'))
  const edge = has(join('Microsoft', 'Edge', 'Application', 'msedge.exe'))
  const args = withBrowserFixes(['-y', '@playwright/mcp@latest'])
  assert.equal(args.includes('msedge'), !chrome && edge)
  const chosen = withBrowserFixes(['-y', '@playwright/mcp@latest', '--browser', 'firefox'])
  assert.equal(chosen.filter((a) => a === '--browser').length, 1)
})

test('other tools are started exactly as installed', () => {
  const args = ['-y', '@upstash/context7-mcp']
  assert.deepEqual(withBrowserFixes(args), args)
})
