import { app } from 'electron'
import { EventEmitter } from 'events'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import type { DeployEvent, Schedule, ScheduleRun, VibeEvent } from '@shared/types'
import { cleanSchedule, describeAction, describeWhen, nextRun, usesAi, type ScheduleInput } from '@shared/schedule'
import { getSettings } from '../settings/store'

// Schedules: run a request, the next to-do, Deploy or a site check at set
// times (or after each Deploy), while VibeApp is running. Each run shows in the
// project's chat marked as scheduled, and the phone hears how it went.

export const scheduleEvents = new EventEmitter()

/** What the scheduler needs from the rest of VibeApp (set up once by the IPC handlers). */
export interface SchedulerDeps {
  projectPath: (projectId: string) => string | undefined
  /** Something is already running in the project (a request, a question, Codex, a deploy). */
  busy: (projectId: string) => boolean
  startRequest: (projectId: string, projectPath: string, text: string, mode: 'build' | 'plan' | 'ask', todoId?: string) => Promise<void>
  startDeploy: (projectId: string, projectPath: string) => Promise<void>
  /** Adds a line to the project's chat (kept in its history, shown on every screen). */
  chatEvent: (projectId: string, event: VibeEvent) => void
  notify: (title: string, body: string) => void
  projectName: (projectId: string) => string
  topTodo: (projectId: string) => { id: string; text: string } | undefined
  /** Claude's highest plan-window usage right now, in percent (undefined if unknown). */
  claudeUsage: () => Promise<number | undefined>
}

let deps: SchedulerDeps | undefined
let timer: NodeJS.Timeout | undefined
let ticking = false

/** Past this, a missed time-of-day run is skipped rather than run late. */
const LATE_GRACE_MS = 3 * 60 * 60 * 1000
/** A due run waits this long for a busy project before it's skipped. */
const BUSY_GIVE_UP_MS = 2 * 60 * 60 * 1000
/** A request that hasn't finished after this is marked as failed. */
const RUN_TIMEOUT_MS = 3 * 60 * 60 * 1000
const KEEP_RUNS = 20
const TICK_MS = 30_000

const file = (): string => join(app.getPath('userData'), 'schedules.json')

function load(): Schedule[] {
  try {
    if (!existsSync(file())) return []
    const list = JSON.parse(readFileSync(file(), 'utf-8')) as Schedule[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function store(list: Schedule[]): void {
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf-8')
  renameSync(tmp, file())
}

function change(id: string, fn: (s: Schedule) => void): Schedule | undefined {
  const list = load()
  const s = list.find((x) => x.id === id)
  if (!s) return undefined
  fn(s)
  s.updatedAt = new Date().toISOString()
  store(list)
  scheduleEvents.emit('changed', s.projectId)
  return s
}

function firstDue(s: Pick<Schedule, 'when'>, now = new Date()): string | undefined {
  if (s.when.kind === 'once') return s.when.at
  return nextRun(s.when, now)?.toISOString()
}

export function listSchedules(projectId?: string): Schedule[] {
  const all = load()
  return projectId ? all.filter((s) => s.projectId === projectId) : all
}

export function getSchedule(id: string): Schedule | undefined {
  return load().find((s) => s.id === id)
}

/**
 * Adds a schedule, or changes one (with `id`). One written by Claude is a draft:
 * it does nothing until the user checks it and turns it on.
 */
export function saveSchedule(projectId: string, input: ScheduleInput & { id?: string }, by: 'claude' | 'user', confirmed: boolean): Schedule {
  const clean = cleanSchedule(input)
  const list = load()
  const now = new Date().toISOString()
  let s = input.id ? list.find((x) => x.id === input.id && x.projectId === projectId) : undefined
  if (s) {
    Object.assign(s, clean, { confirmed: confirmed || (s.confirmed && by === 'user'), updatedAt: now })
    if (by === 'claude') s.by = 'claude'
  } else {
    if (list.filter((x) => x.projectId === projectId).length >= 30) throw new Error('A project can have at most 30 schedules.')
    s = { id: randomUUID(), projectId, ...clean, confirmed, by, runs: [], createdAt: now, updatedAt: now }
    list.push(s)
  }
  if (!s.confirmed) s.enabled = false
  s.nextAt = s.enabled ? firstDue(s) : undefined
  if (clean.action.kind !== 'site_check') delete s.siteUp
  store(list)
  scheduleEvents.emit('changed', projectId)
  if (by === 'claude') scheduleEvents.emit('ready', projectId, s)
  return s
}

/** The user checked a draft and turned it on (or switched one on or off). */
export function setScheduleEnabled(id: string, enabled: boolean): Schedule | undefined {
  return change(id, (s) => {
    s.enabled = enabled
    if (enabled) s.confirmed = true
    s.nextAt = enabled ? firstDue(s) : undefined
    if (enabled && s.when.kind === 'once' && s.nextAt && Date.parse(s.nextAt) < Date.now()) {
      throw new Error('That time has already passed: choose a new one.')
    }
  })
}

export function removeSchedule(id: string): void {
  const list = load()
  const s = list.find((x) => x.id === id)
  if (!s) return
  store(list.filter((x) => x.id !== id))
  scheduleEvents.emit('changed', s.projectId)
}

/** A project was erased: its schedules go with it. */
export function removeSchedulesFor(projectId: string): void {
  const list = load()
  if (!list.some((s) => s.projectId === projectId)) return
  store(list.filter((s) => s.projectId !== projectId))
  scheduleEvents.emit('changed', projectId)
}

/** Every enabled schedule's next time, soonest first (for the tray and Settings). */
export function upcoming(limit = 5): { schedule: Schedule; at: string }[] {
  return load()
    .filter((s) => s.enabled && s.confirmed && s.nextAt)
    .map((s) => ({ schedule: s, at: s.nextAt! }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(0, limit)
}

// ---- running ---------------------------------------------------------------------------

/** Per project: the scheduled request running in it right now. */
const active = new Map<string, { scheduleId: string; runAt: string; started: number; name: string; waiting?: string; error?: string }>()
/** Per project: when a scheduled request last finished (the tray's own "finished" alert is skipped then). */
const recentlyFinished = new Map<string, number>()
/** Schedules waiting for a busy project: since when. */
const waitingSince = new Map<string, number>()
/** Deploys started by a schedule: project → schedule id and run. */
const deploys = new Map<string, { scheduleId: string; runAt: string }>()
/** Site checks running now. */
const checking = new Set<string>()

/** A scheduled request is running in the project, or just finished (so the tray needn't announce it too). */
export function isScheduledRun(projectId: string): boolean {
  return active.has(projectId) || Date.now() - (recentlyFinished.get(projectId) ?? 0) < 15_000
}

function addRun(id: string, run: ScheduleRun): void {
  change(id, (s) => {
    s.runs = [run, ...s.runs].slice(0, KEEP_RUNS)
  })
}

function setRun(id: string, at: string, patch: Partial<ScheduleRun>): void {
  change(id, (s) => {
    const run = s.runs.find((r) => r.at === at)
    if (run) Object.assign(run, patch)
  })
}

/** Moves a schedule on to its next time (a one-off turns itself off). */
function advance(s: Schedule, now: Date): void {
  change(s.id, (x) => {
    if (x.when.kind === 'once') {
      x.enabled = false
      x.nextAt = undefined
    } else {
      x.nextAt = nextRun(x.when, now)?.toISOString()
    }
  })
}

function skip(s: Schedule, detail: string, trigger: ScheduleRun['trigger'], tell = true): void {
  addRun(s.id, { at: new Date().toISOString(), status: 'skipped', detail, trigger })
  deps?.chatEvent(s.projectId, { type: 'schedule_note', name: s.name, text: `⏰ Skipped "${s.name}": ${detail}` })
  if (tell) deps?.notify(`${deps.projectName(s.projectId)}: ⏰ ${s.name} skipped`, detail)
}

function runsToday(s: Schedule): number {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return s.runs.filter((r) => r.status !== 'skipped' && Date.parse(r.at) >= start.getTime()).length
}

/** Starts one run of a schedule. Returns false if it has to wait (the project is busy). */
async function start(s: Schedule, trigger: ScheduleRun['trigger']): Promise<boolean> {
  if (!deps) return false
  const path = deps.projectPath(s.projectId)
  if (!path) {
    skip(s, "the project isn't in VibeApp any more.", trigger, false)
    return true
  }
  if (s.action.kind === 'site_check') {
    void siteCheck(s, path, trigger)
    return true
  }
  if (deps.busy(s.projectId) || active.has(s.projectId) || deploys.has(s.projectId)) return false

  if (usesAi(s.action) && trigger !== 'manual') {
    if (runsToday(s) >= s.maxPerDay) {
      skip(s, `it already ran ${s.maxPerDay} time${s.maxPerDay === 1 ? '' : 's'} today (its daily limit).`, trigger)
      return true
    }
    if (s.skipAboveUsage > 0) {
      const used = await deps.claudeUsage().catch(() => undefined)
      if (used !== undefined && used >= s.skipAboveUsage) {
        skip(s, `Claude's plan usage is at ${Math.round(used)}% (this schedule skips at ${s.skipAboveUsage}% or more).`, trigger)
        return true
      }
    }
  }

  const at = new Date().toISOString()
  switch (s.action.kind) {
    case 'deploy': {
      addRun(s.id, { at, status: 'running', trigger })
      deps.chatEvent(s.projectId, { type: 'schedule_note', name: s.name, text: `⏰ Scheduled: "${s.name}" is running Deploy.` })
      deploys.set(s.projectId, { scheduleId: s.id, runAt: at })
      try {
        await deps.startDeploy(s.projectId, path)
      } catch (err) {
        deploys.delete(s.projectId)
        setRun(s.id, at, { status: 'failed', detail: (err as Error).message })
        deps.notify(`${deps.projectName(s.projectId)}: ⏰ ${s.name} failed`, (err as Error).message)
      }
      return true
    }
    case 'request':
    case 'next_todo': {
      let text: string
      let todoId: string | undefined
      if (s.action.kind === 'next_todo') {
        const todo = deps.topTodo(s.projectId)
        if (!todo) {
          skip(s, 'the to-do list is empty.', trigger, false)
          return true
        }
        text = todo.text
        todoId = todo.id
      } else {
        text = s.action.text
      }
      const mode = s.action.mode
      addRun(s.id, { at, status: 'running', trigger })
      active.set(s.projectId, { scheduleId: s.id, runAt: at, started: Date.now(), name: s.name })
      deps.chatEvent(s.projectId, { type: 'scheduled_run', scheduleId: s.id, name: s.name, what: describeAction(s.action), text })
      try {
        await deps.startRequest(s.projectId, path, text, mode, todoId)
      } catch (err) {
        finishRequest(s.projectId, 'failed', (err as Error).message)
      }
      return true
    }
  }
  return true
}

function finishRequest(projectId: string, status: ScheduleRun['status'], detail?: string): void {
  const run = active.get(projectId)
  if (!run || !deps) return
  active.delete(projectId)
  recentlyFinished.set(projectId, Date.now())
  setRun(run.scheduleId, run.runAt, { status, detail })
  const name = deps.projectName(projectId)
  if (status === 'ok') deps.notify(`${name}: ⏰ ${run.name} done`, detail ?? 'The scheduled request finished.')
  else if (status === 'failed') deps.notify(`${name}: ⏰ ${run.name} failed`, detail ?? 'The scheduled request did not finish.')
  // 'waiting' (a plan to approve, a question): the usual alert for that has already gone out.
}

/** Follows the chat to see how a scheduled request went. */
export function watchChatEvent(projectId: string, event: VibeEvent): void {
  const run = active.get(projectId)
  if (!run) return
  switch (event.type) {
    case 'plan_proposed':
      run.waiting = 'A plan is ready for you to approve.'
      break
    case 'takeover_offer':
      run.waiting = "Claude is out: it's waiting for you to let Codex do it."
      break
    case 'error':
      run.error = event.message
      break
    case 'stopped':
      finishRequest(projectId, 'failed', 'Stopped.')
      break
    case 'turn_complete':
      if (run.waiting) finishRequest(projectId, 'waiting', run.waiting)
      else if (run.error) finishRequest(projectId, 'failed', run.error)
      else finishRequest(projectId, 'ok')
      break
  }
}

/** Follows deploys: a scheduled one's result, and "after each Deploy" schedules. */
export function watchDeployEvent(projectId: string, event: DeployEvent): void {
  if (event.type !== 'finished') return
  const scheduled = deploys.get(projectId)
  if (scheduled) {
    deploys.delete(projectId)
    setRun(scheduled.scheduleId, scheduled.runAt, {
      status: event.ok ? 'ok' : 'failed',
      detail: event.ok ? event.checkDetail : event.stopped ? 'Stopped.' : `Failed at "${event.failedStep}"${event.rolledBack ? '; rolled back' : ''}.`
    })
  }
  if (!event.ok || getSettings().schedulesPaused) return
  // After the deploy has let go of the project.
  setTimeout(() => {
    for (const s of load()) {
      if (s.projectId === projectId && s.enabled && s.confirmed && s.when.kind === 'after_deploy') queueAfterDeploy(s.id)
    }
    void tick()
  }, 1000)
}

const afterDeployQueue = new Set<string>()
function queueAfterDeploy(id: string): void {
  afterDeployQueue.add(id)
  waitingSince.set(id, Date.now())
}

// ---- site checks ------------------------------------------------------------------------

async function probe(url: string): Promise<{ ok: boolean; detail: string }> {
  let last = ''
  // Two tries a little apart, so a moment's hiccup doesn't page anyone.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })
      last = `HTTP ${res.status}`
      if (res.status >= 200 && res.status < 400) return { ok: true, detail: `${url} answered ${last}` }
    } catch (err) {
      last = (err as Error).message
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, process.env.VIBEAPP_TEST_HOOKS === '1' ? 500 : 20_000))
  }
  return { ok: false, detail: `${url} isn't answering (${last})` }
}

async function siteCheck(s: Schedule, path: string, trigger: ScheduleRun['trigger']): Promise<void> {
  if (s.action.kind !== 'site_check' || !deps || checking.has(s.id)) return
  checking.add(s.id)
  try {
    const result = await probe(s.action.url)
    const fresh = getSchedule(s.id)
    if (!fresh) return
    const was = fresh.siteUp
    change(s.id, (x) => {
      x.siteUp = result.ok
    })
    const name = deps.projectName(s.projectId)
    // Only changes are worth a line in the chat and a phone alert (and every manual check).
    if (result.ok && (was === false || trigger === 'manual')) {
      addRun(s.id, { at: new Date().toISOString(), status: 'ok', detail: was === false ? `Back up: ${result.detail}` : result.detail, trigger })
      if (was === false) {
        deps.chatEvent(s.projectId, { type: 'schedule_note', name: s.name, text: `⏰ "${s.name}": the site is back up (${result.detail}).` })
        deps.notify(`${name}: site back up`, result.detail)
      }
    } else if (!result.ok && (was !== false || trigger === 'manual')) {
      addRun(s.id, { at: new Date().toISOString(), status: 'failed', detail: result.detail, trigger })
      deps.chatEvent(s.projectId, { type: 'schedule_note', name: s.name, text: `⏰ "${s.name}": the site is down. ${result.detail}.` })
      deps.notify(`${name}: site down`, result.detail)
      // Once per outage: ask Claude to look, if the schedule says to.
      if (was !== false && s.action.onDown) {
        const text = `${s.action.onDown}\n\n(VibeApp's site check found: ${result.detail}.)`
        if (!deps.busy(s.projectId) && !active.has(s.projectId)) {
          const at = new Date().toISOString()
          addRun(s.id, { at, status: 'running', detail: 'Asked Claude to look into it.', trigger })
          active.set(s.projectId, { scheduleId: s.id, runAt: at, started: Date.now(), name: s.name })
          deps.chatEvent(s.projectId, { type: 'scheduled_run', scheduleId: s.id, name: s.name, what: 'The site is down: asking Claude to look', text })
          await deps.startRequest(s.projectId, path, text, 'build').catch((err: Error) => finishRequest(s.projectId, 'failed', err.message))
        }
      }
    }
  } finally {
    checking.delete(s.id)
  }
}

// ---- the clock --------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (ticking || !deps) return
  ticking = true
  try {
    const now = new Date()
    const paused = getSettings().schedulesPaused
    // A scheduled request that never finished.
    for (const [projectId, run] of active) {
      if (Date.now() - run.started > RUN_TIMEOUT_MS) finishRequest(projectId, 'failed', 'It ran for over 3 hours without finishing.')
    }
    for (const s of load()) {
      if (!s.enabled || !s.confirmed) continue
      // "After each Deploy" runs wait their turn here too.
      if (afterDeployQueue.has(s.id)) {
        if (paused) {
          afterDeployQueue.delete(s.id)
          continue
        }
        if (await start(s, 'deploy')) {
          afterDeployQueue.delete(s.id)
          waitingSince.delete(s.id)
        } else if (Date.now() - (waitingSince.get(s.id) ?? Date.now()) > BUSY_GIVE_UP_MS) {
          afterDeployQueue.delete(s.id)
          waitingSince.delete(s.id)
          skip(s, 'the project was busy for over 2 hours.', 'deploy')
        }
        continue
      }
      if (!s.nextAt) continue
      const due = Date.parse(s.nextAt)
      if (due > now.getTime()) continue
      if (paused) {
        // Paused: nothing runs, and nothing is made up for afterwards.
        advance(s, now)
        continue
      }
      const late = now.getTime() - due
      if (s.when.kind !== 'every' && late > LATE_GRACE_MS) {
        skip(s, `VibeApp wasn't running at ${new Date(due).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`, 'late', false)
        advance(s, now)
        continue
      }
      const trigger: ScheduleRun['trigger'] = late > 10 * 60_000 ? 'late' : 'time'
      if (await start(s, trigger)) {
        waitingSince.delete(s.id)
        advance(s, now)
      } else {
        if (!waitingSince.has(s.id)) waitingSince.set(s.id, Date.now())
        if (Date.now() - waitingSince.get(s.id)! > BUSY_GIVE_UP_MS) {
          waitingSince.delete(s.id)
          skip(s, 'the project was busy for over 2 hours.', trigger)
          advance(s, now)
        }
      }
    }
  } catch (err) {
    console.warn('Checking schedules failed:', (err as Error).message)
  } finally {
    ticking = false
  }
}

/** "Run now" from the Schedules window: runs straight away (limits don't apply; a busy project says so). */
export async function runScheduleNow(id: string): Promise<{ started: boolean; reason?: string }> {
  const s = getSchedule(id)
  if (!s) throw new Error('That schedule no longer exists.')
  if (!s.confirmed) throw new Error('Check this schedule and turn it on first.')
  const started = await start(s, 'manual')
  return started ? { started } : { started, reason: 'The project is busy right now; try again when it has finished.' }
}

export function startScheduler(d: SchedulerDeps): void {
  deps = d
  if (timer) return
  timer = setInterval(() => void tick(), process.env.VIBEAPP_SCHEDULE_TICK_MS ? Number(process.env.VIBEAPP_SCHEDULE_TICK_MS) : TICK_MS)
  timer.unref()
  // Shortly after start: anything missed while VibeApp was closed.
  setTimeout(() => void tick(), 5000).unref()
}

/** The plain-words summary used in the chat card and by Claude. */
export function summarize(s: Pick<Schedule, 'action' | 'when'>): string {
  return `${describeAction(s.action)} · ${describeWhen(s.when)}`
}
