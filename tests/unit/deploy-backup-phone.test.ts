import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { app } from 'electron'
import type { DeployEvent } from '@shared/types'
import { cleanRecipe, deployEvents, getRecipe, runDeploy, saveRecipe } from '../../src/main/deploy/deploy'
import { applyPendingRestore, backupNow, listBackups, stageRestore } from '../../src/main/backup/backup'
import { sendPhoneAlert } from '../../src/main/notify/phone'
import { getSettings, updateSettings } from '../../src/main/settings/store'
import { addTodo, closeMemory, listTodos } from '../../src/main/memory/store'
import { memoryDb } from '../../src/main/memory/paths'

/** A local web server for the site check and for a stand-in ntfy. */
function server(handler: (req: { method?: string; url?: string; headers: Record<string, unknown>; body: string }) => number) {
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const s = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.statusCode = handler({ method: req.method, url: req.url, headers: req.headers, body })
        res.end('ok')
      })
    })
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() }))
  })
}

test('a deploy recipe is checked: steps needed, no secret values, a real web address', () => {
  assert.throws(() => cleanRecipe({ name: 'x', steps: [] }), /at least one step/)
  assert.throws(() => cleanRecipe({ steps: [{ label: 'up', run: 'curl -H "Authorization: sk-ant-api03-abcdefghijklmnopqrstuvwxyz" x' }] }), /Secrets/)
  assert.throws(() => cleanRecipe({ steps: [{ label: 'a', run: 'echo hi' }], check: { url: 'not a url' } }), /web address/)
  const ok = cleanRecipe({ name: 'Deploy', steps: [{ label: '', run: 'echo hi' }] })
  assert.equal(ok.steps[0].label, 'Step 1')
  assert.equal(ok.shell, 'bash')
})

test('Deploy runs the steps in order, checks the site, and Claude-written recipes wait to be confirmed', { skip: process.platform !== 'win32' && !existsSync('/bin/bash') }, async () => {
  const site = await server(() => 200)
  const project = mkdtempSync(join(tmpdir(), 'vibeapp-deploy-'))
  saveRecipe('deploy-ok', { name: 'Test deploy', steps: [{ label: 'Write a file', run: 'echo built > out.txt' }, { label: 'Read it', run: 'cat out.txt' }], check: { url: site.url } }, 'claude', false)
  assert.equal(getRecipe('deploy-ok')?.confirmed, false)
  await assert.rejects(runDeploy('deploy-ok', project), /Check the deploy recipe/)

  saveRecipe('deploy-ok', getRecipe('deploy-ok') ?? {}, 'user', true)
  const events: DeployEvent[] = []
  const listen = (id: string, e: DeployEvent): void => {
    if (id === 'deploy-ok') events.push(e)
  }
  deployEvents.on('event', listen)
  const result = await runDeploy('deploy-ok', project)
  deployEvents.off('event', listen)
  site.close()
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(readFileSync(join(project, 'out.txt'), 'utf-8').trim(), 'built', 'steps run in the project folder')
  assert.ok(events.some((e) => e.type === 'output' && /built/.test(e.text)), 'output is streamed')
  assert.ok(events.some((e) => e.type === 'check' && e.status === 'ok'))
})

test('a failing step stops the deploy and runs the rollback steps', { skip: process.platform !== 'win32' && !existsSync('/bin/bash') }, async () => {
  const project = mkdtempSync(join(tmpdir(), 'vibeapp-deploy-'))
  saveRecipe(
    'deploy-bad',
    {
      name: 'Bad deploy',
      steps: [{ label: 'Fine', run: 'echo one > a.txt' }, { label: 'Breaks', run: 'echo oops; exit 3' }, { label: 'Never runs', run: 'echo three > c.txt' }],
      rollback: [{ label: 'Put back', run: 'echo restored > rolledback.txt' }]
    },
    'user',
    true
  )
  const result = await runDeploy('deploy-bad', project)
  assert.equal(result.ok, false)
  assert.equal(result.failedStep, 'Breaks')
  assert.match(result.output ?? '', /oops/)
  assert.equal(result.rolledBack, true)
  assert.ok(existsSync(join(project, 'rolledback.txt')))
  assert.ok(!existsSync(join(project, 'c.txt')), 'steps after the failure are not run')
})

test("a backup copies VibeApp's data, and restoring puts it back as it was", () => {
  updateSettings({ backupDir: mkdtempSync(join(tmpdir(), 'vibeapp-backups-')), backupKeep: 2 })
  addTodo(memoryDb(), 'backup-project', 'Remember me', 'user')
  writeFileSync(join(app.getPath('userData'), 'projects.json'), JSON.stringify({ projects: [{ id: 'backup-project', name: 'before' }] }))
  const first = backupNow('manual')
  assert.ok(existsSync(join(first.path, 'memory.db')))
  assert.ok(existsSync(join(first.path, 'projects.json')))
  assert.ok(first.bytes > 0)

  // Things change after the backup...
  writeFileSync(join(app.getPath('userData'), 'projects.json'), JSON.stringify({ projects: [{ id: 'backup-project', name: 'after' }] }))
  // ...then it's restored (applied at the next start, which this stands in for).
  stageRestore(first.path)
  addTodo(memoryDb(), 'backup-project', 'Added after the backup', 'user')
  closeMemory() // as when VibeApp restarts
  applyPendingRestore()
  assert.match(readFileSync(join(app.getPath('userData'), 'projects.json'), 'utf-8'), /"before"/)
  assert.deepEqual(listTodos(memoryDb(), 'backup-project').map((t) => t.text), ['Remember me'], 'the database is back as it was')
  // A backup was made just before restoring, so the restore can be undone.
  const all = listBackups()
  assert.ok(all.some((b) => b.reason === 'before restore'))
  assert.ok(all.length <= 2, 'only the newest are kept')
})

test('a phone alert is posted to the ntfy topic with a plain title', async () => {
  const received: { url?: string; title?: unknown; body: string }[] = []
  const ntfy = await server((req) => {
    received.push({ url: req.url, title: req.headers.title, body: req.body })
    return 200
  })
  updateSettings({ phoneAlerts: false, phoneAlertServer: ntfy.url, phoneAlertTopic: 'vibeapp-testtopic' })
  assert.equal((await sendPhoneAlert('yay: plan ready', 'Claude has a plan')).ok, false, 'nothing is sent while alerts are off')
  updateSettings({ phoneAlerts: true })
  const sent = await sendPhoneAlert('yay: plan ready ✅', 'Claude has a plan for you to approve.')
  ntfy.close()
  assert.equal(sent.ok, true, sent.error)
  assert.equal(received.length, 1)
  assert.equal(received[0].url, '/vibeapp-testtopic')
  assert.equal(received[0].title, 'yay: plan ready', 'header text kept to plain characters')
  assert.match(received[0].body, /approve/)
  assert.equal(getSettings().phoneAlertTopic, 'vibeapp-testtopic')
})
