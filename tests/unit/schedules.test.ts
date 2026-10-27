import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { app } from 'electron'
import type { Schedule, VibeEvent } from '@shared/types'
import { cleanSchedule, describeWhen, nextRun } from '@shared/schedule'
import {
  getSchedule,
  listSchedules,
  removeSchedule,
  runScheduleNow,
  saveSchedule,
  scheduleEvents,
  setScheduleEnabled,
  startScheduler,
  watchChatEvent,
  watchDeployEvent
} from '../../src/main/schedule/scheduler'
import { updateSettings } from '../../src/main/settings/store'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('next run: a time of day on chosen days, every few hours, once', () => {
  // Friday 2026-10-30 08:00 local.
  const fri = new Date(2026, 9, 30, 8, 0)
  const daily = nextRun({ kind: 'daily', time: '07:00', days: [0, 1, 2, 3, 4, 5, 6] }, fri)!
  assert.equal(daily.getDate(), 31) // already past 7:00 today: tomorrow
  assert.equal(daily.getHours(), 7)
  const later = nextRun({ kind: 'daily', time: '09:30', days: [0, 1, 2, 3, 4, 5, 6] }, fri)!
  assert.equal(later.getDate(), 30) // still to come today
  const weekdays = nextRun({ kind: 'daily', time: '07:00', days: [1, 2, 3, 4, 5] }, fri)!
  assert.equal(weekdays.getDay(), 1) // skips the weekend: Monday
  assert.equal(weekdays.getDate(), 2)
  assert.equal(nextRun({ kind: 'every', minutes: 120 }, fri)!.getTime(), fri.getTime() + 2 * 3600_000)
  assert.equal(nextRun({ kind: 'once', at: new Date(2026, 9, 29).toISOString() }, fri), null)
  assert.equal(nextRun({ kind: 'after_deploy' }, fri), null)
  assert.equal(describeWhen({ kind: 'daily', time: '07:00', days: [1, 2, 3, 4, 5] }).startsWith('Weekdays at'), true)
  assert.equal(describeWhen({ kind: 'every', minutes: 15 }), 'Every 15 minutes')
})

test('a schedule is checked: a request, sensible times, no secrets, limits kept in range', () => {
  assert.throws(() => cleanSchedule({ action: { kind: 'request', text: ' ', mode: 'build' }, when: { kind: 'every', minutes: 60 } }), /what the schedule should ask/)
  assert.throws(() => cleanSchedule({ action: { kind: 'request', text: 'go', mode: 'build' }, when: { kind: 'every', minutes: 10 } }), /once an hour/)
  assert.throws(() => cleanSchedule({ action: { kind: 'site_check', url: 'x' }, when: { kind: 'every', minutes: 15 } }), /web address/)
  assert.throws(() => cleanSchedule({ action: { kind: 'site_check', url: 'https://a.b/' }, when: { kind: 'every', minutes: 2 } }), /every 5 minutes/)
  assert.throws(() => cleanSchedule({ action: { kind: 'deploy' }, when: { kind: 'after_deploy' } }), /can't run after each Deploy/)
  assert.throws(() => cleanSchedule({ action: { kind: 'request', text: 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz', mode: 'build' }, when: { kind: 'every', minutes: 60 } }), /secret/)
  assert.throws(() => cleanSchedule({ action: { kind: 'deploy' }, when: { kind: 'daily', time: '25:00', days: [1] } }), /time of day/)
  assert.throws(() => cleanSchedule({ action: { kind: 'deploy' }, when: { kind: 'daily', time: '07:00', days: [] } }), /at least one day/)
  const ok = cleanSchedule({ action: { kind: 'request', text: 'Run the tests', mode: 'build' }, when: { kind: 'daily', time: '07:00', days: [5, 1, 1] }, maxPerDay: 99 })
  assert.deepEqual(ok.when, { kind: 'daily', time: '07:00', days: [1, 5] })
  assert.equal(ok.maxPerDay, 24)
  assert.equal(ok.skipAboveUsage, 90)
  assert.match(ok.name, /Build: "Run the tests"/)
})

// ---- the scheduler, with stand-ins for the rest of VibeApp ----

const started: { projectId: string; text: string; mode: string; todoId?: string }[] = []
const deploysStarted: string[] = []
const backups: string[] = []
const notes: string[] = []
const alerts: string[] = []
let busy = false
let usage: number | undefined = 10
let todo: { id: string; text: string } | undefined

process.env.VIBEAPP_SCHEDULE_TICK_MS = '100'
process.env.VIBEAPP_TEST_HOOKS = '1'
startScheduler({
  projectPath: (id) => (id === 'gone' ? undefined : `C:/projects/${id}`),
  busy: () => busy,
  startRequest: async (projectId, _path, text, mode, todoId) => {
    started.push({ projectId, text, mode, todoId })
  },
  startDeploy: async (projectId) => {
    deploysStarted.push(projectId)
  },
  backup: async (projectId) => {
    backups.push(projectId)
    if (projectId === 'nogh') throw new Error('This project has no GitHub copy yet: make one in Publish.')
    return 'Uploaded to GitHub.'
  },
  chatEvent: (_projectId, event: VibeEvent) => {
    if (event.type === 'schedule_note' || event.type === 'scheduled_run') notes.push(event.type === 'schedule_note' ? event.text : `run: ${event.name}`)
  },
  notify: (title, body) => alerts.push(`${title} | ${body}`),
  projectName: (id) => `Project ${id}`,
  topTodo: () => todo,
  claudeUsage: async () => usage
})

/** Makes a schedule due now (or `agoMs` ago), as if its time had come. */
function makeDue(id: string, agoMs = 1000): void {
  const file = join(app.getPath('userData'), 'schedules.json')
  const list = JSON.parse(readFileSync(file, 'utf-8')) as Schedule[]
  list.find((s) => s.id === id)!.nextAt = new Date(Date.now() - agoMs).toISOString()
  writeFileSync(file, JSON.stringify(list))
}

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await sleep(50)
  }
  throw new Error(`timed out: ${what}`)
}

test('a due request runs as Build, shows in the chat, and is marked done when the turn finishes', async () => {
  const s = saveSchedule('p1', { name: 'Morning tests', action: { kind: 'request', text: 'Run the tests', mode: 'build' }, when: { kind: 'every', minutes: 60 } }, 'user', true)
  assert.ok(s.nextAt && Date.parse(s.nextAt) > Date.now())
  makeDue(s.id)
  await until(() => started.some((r) => r.text === 'Run the tests'), 'the request to start')
  assert.equal(started.at(-1)!.mode, 'build')
  assert.ok(notes.includes('run: Morning tests'))
  assert.equal(getSchedule(s.id)!.runs[0].status, 'running')
  assert.ok(Date.parse(getSchedule(s.id)!.nextAt!) > Date.now() + 50 * 60_000, 'moved on to the next time')
  watchChatEvent('p1', { type: 'turn_complete' })
  assert.equal(getSchedule(s.id)!.runs[0].status, 'ok')
  assert.ok(alerts.some((a) => a.includes('Morning tests done')))
  removeSchedule(s.id)
})

test('a busy project makes it wait its turn; a plan waits for the user', async () => {
  const s = saveSchedule('p2', { name: 'Plan it', action: { kind: 'request', text: 'Plan the shop page', mode: 'plan' }, when: { kind: 'every', minutes: 60 } }, 'user', true)
  busy = true
  makeDue(s.id)
  await sleep(400)
  assert.ok(!started.some((r) => r.text === 'Plan the shop page'), 'should wait while busy')
  busy = false
  await until(() => started.some((r) => r.text === 'Plan the shop page'), 'it to run once free')
  assert.equal(started.at(-1)!.mode, 'plan')
  watchChatEvent('p2', { type: 'plan_proposed', toolUseId: 't', plan: 'x', steps: [] })
  watchChatEvent('p2', { type: 'turn_complete' })
  assert.equal(getSchedule(s.id)!.runs[0].status, 'waiting')
  removeSchedule(s.id)
})

test('the daily limit and the usage guard skip a run, and say so', async () => {
  const s = saveSchedule('p3', { name: 'Capped', action: { kind: 'request', text: 'Tidy up', mode: 'build' }, when: { kind: 'every', minutes: 60 }, maxPerDay: 1 }, 'user', true)
  makeDue(s.id)
  await until(() => started.some((r) => r.text === 'Tidy up'), 'the first run')
  watchChatEvent('p3', { type: 'turn_complete' })
  makeDue(s.id)
  await until(() => getSchedule(s.id)!.runs[0].status === 'skipped', 'the second run to be skipped')
  assert.match(getSchedule(s.id)!.runs[0].detail!, /daily limit/)
  assert.equal(started.filter((r) => r.text === 'Tidy up').length, 1)
  removeSchedule(s.id)

  usage = 95
  const g = saveSchedule('p3', { name: 'Guarded', action: { kind: 'request', text: 'Refactor', mode: 'build' }, when: { kind: 'every', minutes: 60 } }, 'user', true)
  makeDue(g.id)
  await until(() => getSchedule(g.id)!.runs[0]?.status === 'skipped', 'the usage guard')
  assert.match(getSchedule(g.id)!.runs[0].detail!, /95%/)
  assert.ok(alerts.some((a) => a.includes('Guarded skipped')))
  usage = 10
  removeSchedule(g.id)
})

test('a time of day missed by more than 3 hours is skipped, not run late; pausing runs nothing', async () => {
  const s = saveSchedule('p4', { name: 'Nightly', action: { kind: 'request', text: 'Nightly job', mode: 'build' }, when: { kind: 'daily', time: '02:00', days: [0, 1, 2, 3, 4, 5, 6] } }, 'user', true)
  makeDue(s.id, 5 * 3600_000)
  await until(() => getSchedule(s.id)!.runs[0]?.status === 'skipped', 'the late run to be skipped')
  assert.match(getSchedule(s.id)!.runs[0].detail!, /wasn't running/)
  assert.ok(Date.parse(getSchedule(s.id)!.nextAt!) > Date.now())
  assert.ok(!started.some((r) => r.text === 'Nightly job'))

  updateSettings({ schedulesPaused: true })
  makeDue(s.id, 60_000)
  await until(() => Date.parse(getSchedule(s.id)!.nextAt!) > Date.now(), 'the paused schedule to move on')
  assert.ok(!started.some((r) => r.text === 'Nightly job'))
  updateSettings({ schedulesPaused: false })
  removeSchedule(s.id)
})

test("Claude's schedule is a draft until the user turns it on; the next to-do runs and is ticked by id", async () => {
  let ready: Schedule | undefined
  scheduleEvents.once('ready', (_p: string, s: Schedule) => (ready = s))
  const d = saveSchedule('p5', { name: 'Next to-do', action: { kind: 'next_todo', mode: 'build' }, when: { kind: 'every', minutes: 60 } }, 'claude', false)
  assert.equal(ready?.id, d.id)
  assert.equal(d.enabled, false)
  assert.equal(d.nextAt, undefined)
  await assert.rejects(runScheduleNow(d.id), /turn it on/)
  const on = setScheduleEnabled(d.id, true)!
  assert.equal(on.confirmed, true)
  assert.ok(on.nextAt)
  todo = { id: 'todo-1', text: 'Add a dark mode' }
  const r = await runScheduleNow(d.id)
  assert.equal(r.started, true)
  assert.deepEqual(started.at(-1), { projectId: 'p5', text: 'Add a dark mode', mode: 'build', todoId: 'todo-1' })
  watchChatEvent('p5', { type: 'turn_complete' })
  assert.equal(listSchedules('p5')[0].runs[0].trigger, 'manual')
  todo = undefined
  removeSchedule(d.id)
})

test('after each Deploy: runs when a deploy succeeds; a scheduled Deploy records its result', async () => {
  const a = saveSchedule('p6', { name: 'Smoke test', action: { kind: 'request', text: 'Smoke test the live site', mode: 'ask' }, when: { kind: 'after_deploy' } }, 'user', true)
  watchDeployEvent('p6', { type: 'finished', ok: false, seconds: 3 })
  await sleep(1500)
  assert.ok(!started.some((r) => r.text === 'Smoke test the live site'), 'not after a failed deploy')
  watchDeployEvent('p6', { type: 'finished', ok: true, seconds: 3 })
  await until(() => started.some((r) => r.text === 'Smoke test the live site'), 'the after-deploy run', 4000)
  assert.equal(started.at(-1)!.mode, 'ask')
  watchChatEvent('p6', { type: 'turn_complete' })
  removeSchedule(a.id)

  const dep = saveSchedule('p7', { name: 'Friday deploy', action: { kind: 'deploy' }, when: { kind: 'every', minutes: 60 } }, 'user', true)
  makeDue(dep.id)
  await until(() => deploysStarted.includes('p7'), 'the deploy to start')
  watchDeployEvent('p7', { type: 'finished', ok: false, seconds: 9, failedStep: 'Upload' })
  assert.equal(getSchedule(dep.id)!.runs[0].status, 'failed')
  assert.match(getSchedule(dep.id)!.runs[0].detail!, /Upload/)
  removeSchedule(dep.id)
})

test('a GitHub backup on a schedule records its result; one that fails says why in the chat and on the phone', async () => {
  const ok = saveSchedule('gh1', { name: 'Nightly backup', action: { kind: 'github_backup' }, when: { kind: 'daily', time: '23:00', days: [0, 1, 2, 3, 4, 5, 6] } }, 'user', true)
  assert.equal(ok.maxPerDay, 3)
  makeDue(ok.id)
  await until(() => getSchedule(ok.id)!.runs[0]?.status === 'ok', 'the backup to run')
  assert.equal(getSchedule(ok.id)!.runs[0].detail, 'Uploaded to GitHub.')
  removeSchedule(ok.id)

  const bad = saveSchedule('nogh', { name: 'Backup', action: { kind: 'github_backup' }, when: { kind: 'every', minutes: 120 } }, 'user', true)
  makeDue(bad.id)
  await until(() => getSchedule(bad.id)!.runs[0]?.status === 'failed', 'the failed backup')
  assert.ok(notes.some((n) => /couldn't back up to GitHub: This project has no GitHub copy/.test(n)))
  assert.ok(alerts.some((a) => a.includes('Backup failed')))
  removeSchedule(bad.id)
})

test('a site check alerts once when the site goes down (and asks Claude once), and again when it is back', async () => {
  let status = 200
  const server = createServer((_req, res) => {
    res.statusCode = status
    res.end('ok')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const s = saveSchedule('p8', { name: 'Site up', action: { kind: 'site_check', url, onDown: 'Look at the server logs' }, when: { kind: 'every', minutes: 5 } }, 'user', true)
  const alertsFor = (): string[] => alerts.filter((a) => a.startsWith('Project p8'))
  makeDue(s.id)
  await until(() => getSchedule(s.id)!.siteUp === true, 'the first check')
  assert.equal(alertsFor().length, 0, 'no alert while it is fine')

  status = 503
  makeDue(s.id)
  await until(() => getSchedule(s.id)!.siteUp === false, 'the site to be seen as down')
  await until(() => started.some((r) => r.text.startsWith('Look at the server logs')), 'Claude to be asked')
  assert.equal(alertsFor().filter((a) => a.includes('site down')).length, 1)
  watchChatEvent('p8', { type: 'turn_complete' })
  makeDue(s.id)
  await sleep(1500)
  assert.equal(alertsFor().filter((a) => a.includes('site down')).length, 1, 'still down: no second alert')
  assert.equal(started.filter((r) => r.text.startsWith('Look at the server logs')).length, 1, 'Claude asked once per outage')

  status = 200
  makeDue(s.id)
  await until(() => getSchedule(s.id)!.siteUp === true, 'the site to be back')
  assert.ok(alertsFor().some((a) => a.includes('back up')))
  server.close()
  removeSchedule(s.id)
})
