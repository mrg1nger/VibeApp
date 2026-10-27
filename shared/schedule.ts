import type { Schedule, ScheduleAction, ScheduleWhen } from './types'
import { detectSecrets } from './secretPatterns'

// Schedules: when each one is next due, what it's called in plain words, and
// the checks a new or edited one has to pass. Shared by VibeApp and its screens.

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const WEEKDAYS = [1, 2, 3, 4, 5]

/** Requests to Claude/Codex: no more often than this. */
export const MIN_REQUEST_MINUTES = 60
/** Site checks (no AI): no more often than this. */
export const MIN_CHECK_MINUTES = 5

/** The next time a schedule is due after `after`, or null when it isn't time-based (or a one-off already passed). */
export function nextRun(when: ScheduleWhen, after: Date): Date | null {
  switch (when.kind) {
    case 'once': {
      const at = new Date(when.at)
      return at.getTime() > after.getTime() ? at : null
    }
    case 'every':
      return new Date(after.getTime() + when.minutes * 60_000)
    case 'daily': {
      const [h, m] = when.time.split(':').map(Number)
      for (let add = 0; add <= 7; add++) {
        const d = new Date(after.getFullYear(), after.getMonth(), after.getDate() + add, h, m, 0, 0)
        if (d.getTime() > after.getTime() && when.days.includes(d.getDay())) return d
      }
      return null
    }
    default:
      return null
  }
}

const sameDays = (a: number[], b: number[]): boolean => a.length === b.length && a.every((d) => b.includes(d))

function clock(time: string): string {
  const [h, m] = time.split(':').map(Number)
  const d = new Date(2000, 0, 1, h, m)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function describeWhen(when: ScheduleWhen): string {
  switch (when.kind) {
    case 'once':
      return `Once, ${new Date(when.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
    case 'every':
      return when.minutes % 60 === 0
        ? when.minutes === 60
          ? 'Every hour'
          : `Every ${when.minutes / 60} hours`
        : `Every ${when.minutes} minutes`
    case 'daily': {
      const days = [...when.days].sort()
      const which =
        days.length === 7 ? 'Every day' : sameDays(days, WEEKDAYS) ? 'Weekdays' : sameDays(days, [0, 6]) ? 'Weekends' : days.map((d) => DAY_NAMES[d]).join(', ')
      return `${which} at ${clock(when.time)}`
    }
    case 'after_deploy':
      return 'After each Deploy'
  }
}

export function describeAction(action: ScheduleAction): string {
  switch (action.kind) {
    case 'request': {
      const mode = action.mode === 'plan' ? 'Plan' : action.mode === 'ask' ? 'Ask' : 'Build'
      const text = action.text.length > 90 ? `${action.text.slice(0, 90)}…` : action.text
      return `${mode}: "${text}"`
    }
    case 'next_todo':
      return action.mode === 'plan' ? 'Plan the top to-do' : 'Build the top to-do'
    case 'deploy':
      return 'Deploy (the saved steps, no AI)'
    case 'site_check':
      return `Check ${action.url} is up${action.onDown ? ', and ask Claude to look if it is down' : ''}`
    case 'github_backup':
      return 'Back up to GitHub (no AI)'
  }
}

/** Runs Claude or Codex (counts against plan usage, so the daily cap and usage guard apply). */
export function usesAi(action: ScheduleAction): boolean {
  return action.kind === 'request' || action.kind === 'next_todo'
}

export type ScheduleInput = Partial<Pick<Schedule, 'name' | 'action' | 'when' | 'enabled' | 'maxPerDay' | 'skipAboveUsage'>>

/** Checks a schedule and tidies it. Throws a plain-words error for anything unusable. */
export function cleanSchedule(input: ScheduleInput): Pick<Schedule, 'name' | 'action' | 'when' | 'enabled' | 'maxPerDay' | 'skipAboveUsage'> {
  const a = (input.action ?? {}) as Partial<ScheduleAction> & Record<string, unknown>
  let action: ScheduleAction
  const mode3 = (m: unknown): 'build' | 'plan' | 'ask' => (m === 'plan' || m === 'ask' ? m : 'build')
  switch (a.kind) {
    case 'request': {
      const text = String(a.text ?? '').trim()
      if (!text) throw new Error('Write what the schedule should ask for.')
      if (text.length > 4000) throw new Error('The request is longer than 4,000 characters.')
      if (detectSecrets(text).length) throw new Error('The request contains what looks like a secret key. Save it in Secrets instead.')
      action = { kind: 'request', text, mode: mode3(a.mode) }
      break
    }
    case 'next_todo':
      action = { kind: 'next_todo', mode: a.mode === 'plan' ? 'plan' : 'build' }
      break
    case 'deploy':
      action = { kind: 'deploy' }
      break
    case 'github_backup':
      action = { kind: 'github_backup' }
      break
    case 'site_check': {
      const url = String(a.url ?? '').trim()
      if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('The site check needs a web address (http:// or https://).')
      const onDown = String(a.onDown ?? '').trim().slice(0, 2000)
      if (onDown && detectSecrets(onDown).length) throw new Error('The request contains what looks like a secret key. Save it in Secrets instead.')
      action = { kind: 'site_check', url, ...(onDown ? { onDown } : {}) }
      break
    }
    default:
      throw new Error('Choose what the schedule runs.')
  }

  const w = (input.when ?? {}) as Partial<ScheduleWhen> & Record<string, unknown>
  let when: ScheduleWhen
  switch (w.kind) {
    case 'once': {
      const at = new Date(String(w.at ?? ''))
      if (Number.isNaN(at.getTime())) throw new Error('Choose a date and time.')
      when = { kind: 'once', at: at.toISOString() }
      break
    }
    case 'daily': {
      const time = String(w.time ?? '')
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Choose a time of day.')
      const days = [...new Set((Array.isArray(w.days) ? w.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      if (!days.length) throw new Error('Choose at least one day.')
      when = { kind: 'daily', time, days }
      break
    }
    case 'every': {
      const minutes = Math.round(Number(w.minutes))
      const min = action.kind === 'site_check' ? MIN_CHECK_MINUTES : MIN_REQUEST_MINUTES
      if (!Number.isFinite(minutes) || minutes < min) {
        throw new Error(action.kind === 'site_check' ? `Check at most every ${MIN_CHECK_MINUTES} minutes.` : 'Run it at most once an hour.')
      }
      when = { kind: 'every', minutes: Math.min(minutes, 7 * 24 * 60) }
      break
    }
    case 'after_deploy':
      if (action.kind === 'deploy') throw new Error("A Deploy can't run after each Deploy.")
      when = { kind: 'after_deploy' }
      break
    default:
      throw new Error('Choose when the schedule runs.')
  }

  const name = String(input.name ?? '').trim().slice(0, 80) || describeAction(action).slice(0, 80)
  const maxPerDay = Math.min(24, Math.max(1, Math.round(Number(input.maxPerDay) || 3)))
  const skip = Number(input.skipAboveUsage)
  const skipAboveUsage = Number.isFinite(skip) && input.skipAboveUsage !== undefined ? Math.min(100, Math.max(0, Math.round(skip))) : 90
  return { name, action, when, enabled: input.enabled !== false, maxPerDay, skipAboveUsage }
}
