import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { ProjectRecord, Schedule, ScheduleAction, ScheduleWhen } from '@shared/types'
import { DAY_NAMES, describeAction, describeWhen, usesAi, WEEKDAYS } from '@shared/schedule'
import Modal from './Modal'

interface ScheduleDialogProps {
  project: ProjectRecord
  onClose: () => void
  onError: (message: string) => void
  /** Open straight on this schedule (a draft Claude wrote). */
  focusId?: string
}

type ActionKind = ScheduleAction['kind']
type WhenKind = 'once' | 'daily' | 'every' | 'after_deploy'

/** The form's state: everything a schedule can be, flattened for the inputs. */
interface Form {
  id?: string
  name: string
  actionKind: ActionKind
  text: string
  mode: 'build' | 'plan' | 'ask'
  url: string
  onDown: string
  whenKind: WhenKind
  at: string
  time: string
  days: number[]
  everyAmount: number
  everyUnit: 'minutes' | 'hours'
  maxPerDay: number
  skipAboveUsage: number
}

const clean = (message: string): string => message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function localInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function blankForm(): Form {
  const soon = new Date(Date.now() + 60 * 60_000)
  soon.setMinutes(0, 0, 0)
  return {
    name: '',
    actionKind: 'request',
    text: '',
    mode: 'build',
    url: '',
    onDown: '',
    whenKind: 'daily',
    at: localInput(soon),
    time: '07:00',
    days: [0, 1, 2, 3, 4, 5, 6],
    everyAmount: 2,
    everyUnit: 'hours',
    maxPerDay: 3,
    skipAboveUsage: 90
  }
}

function toForm(s: Schedule): Form {
  const f = blankForm()
  f.id = s.id
  f.name = s.name
  f.actionKind = s.action.kind
  if (s.action.kind === 'request') {
    f.text = s.action.text
    f.mode = s.action.mode
  }
  if (s.action.kind === 'next_todo') f.mode = s.action.mode
  if (s.action.kind === 'site_check') {
    f.url = s.action.url
    f.onDown = s.action.onDown ?? ''
  }
  f.whenKind = s.when.kind
  if (s.when.kind === 'once') f.at = localInput(new Date(s.when.at))
  if (s.when.kind === 'daily') {
    f.time = s.when.time
    f.days = s.when.days
  }
  if (s.when.kind === 'every') {
    const hours = s.when.minutes % 60 === 0
    f.everyUnit = hours ? 'hours' : 'minutes'
    f.everyAmount = hours ? s.when.minutes / 60 : s.when.minutes
  }
  f.maxPerDay = s.maxPerDay
  f.skipAboveUsage = s.skipAboveUsage
  return f
}

function fromForm(f: Form): { id?: string; name: string; action: ScheduleAction; when: ScheduleWhen; maxPerDay: number; skipAboveUsage: number } {
  const action: ScheduleAction =
    f.actionKind === 'request'
      ? { kind: 'request', text: f.text, mode: f.mode }
      : f.actionKind === 'next_todo'
        ? { kind: 'next_todo', mode: f.mode === 'plan' ? 'plan' : 'build' }
        : f.actionKind === 'deploy'
          ? { kind: 'deploy' }
          : f.actionKind === 'github_backup'
            ? { kind: 'github_backup' }
            : { kind: 'site_check', url: f.url, onDown: f.onDown }
  const when: ScheduleWhen =
    f.whenKind === 'once'
      ? { kind: 'once', at: new Date(f.at).toISOString() }
      : f.whenKind === 'daily'
        ? { kind: 'daily', time: f.time, days: f.days }
        : f.whenKind === 'every'
          ? { kind: 'every', minutes: f.everyUnit === 'hours' ? f.everyAmount * 60 : f.everyAmount }
          : { kind: 'after_deploy' }
  return { id: f.id, name: f.name, action, when, maxPerDay: f.maxPerDay, skipAboveUsage: f.skipAboveUsage }
}

function ago(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString([], new Date().toDateString() === d.toDateString() ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

const RUN_MARK: Record<string, string> = { running: '▶', ok: '✓', failed: '✗', skipped: '–', waiting: '⏸' }
const RUN_WORD: Record<string, string> = { running: 'running', ok: 'done', failed: 'failed', skipped: 'skipped', waiting: 'waiting for you' }

/** A project's schedules: what runs when, how the last runs went, and adding or changing one. */
function ScheduleDialog({ project, onClose, onError, focusId }: ScheduleDialogProps) {
  const [list, setList] = useState<Schedule[] | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(() => {
    window.vibe.schedules
      .list(project.id)
      .then(setList)
      .catch((err: Error) => onError(clean(err.message)))
  }, [project.id, onError])

  useEffect(() => {
    load()
    return window.vibe.schedules.onChanged((id) => id === project.id && load())
  }, [project.id, load])

  const act = async (work: () => Promise<unknown>): Promise<void> => {
    try {
      await work()
      load()
    } catch (err) {
      onError(clean((err as Error).message))
    }
  }

  const save = async (): Promise<void> => {
    if (!form) return
    setSaving(true)
    try {
      await window.vibe.schedules.save(project.id, fromForm(form))
      setForm(null)
      load()
    } catch (err) {
      onError(clean((err as Error).message))
    } finally {
      setSaving(false)
    }
  }

  const runNow = async (s: Schedule): Promise<void> => {
    try {
      const r = await window.vibe.schedules.runNow(s.id)
      setNote(r.started ? `"${s.name}" is running: follow it in the chat.` : r.reason ?? '')
      load()
    } catch (err) {
      onError(clean((err as Error).message))
    }
  }

  let body: ReactElement
  if (list === null) {
    body = <p className="modal-text">Loading…</p>
  } else if (form) {
    const set = (patch: Partial<Form>): void => setForm({ ...form, ...patch })
    const ai = usesAi(fromForm(form).action)
    body = (
      <div className="schedule-form">
        <label className="settings-field">
          What it runs
          <select value={form.actionKind} onChange={(e) => set({ actionKind: e.target.value as ActionKind, whenKind: e.target.value === 'site_check' && form.whenKind === 'daily' ? 'every' : form.whenKind, everyAmount: e.target.value === 'site_check' ? 15 : form.everyAmount, everyUnit: e.target.value === 'site_check' ? 'minutes' : form.everyUnit })}>
            <option value="request">A request to Claude</option>
            <option value="next_todo">The top item on the to-do list</option>
            <option value="deploy">Deploy (the saved steps, no AI)</option>
            <option value="site_check">Check the site is up (no AI)</option>
            <option value="github_backup">Back up to GitHub (no AI)</option>
          </select>
        </label>
        {form.actionKind === 'github_backup' && (
          <p className="modal-muted">
            Uploads the project to its GitHub copy (make one in Publish first). Nothing is uploaded when there&apos;s
            nothing new.
          </p>
        )}

        {form.actionKind === 'request' && (
          <label className="settings-field">
            The request
            <textarea rows={3} value={form.text} onChange={(e) => set({ text: e.target.value })} placeholder="e.g. Run the tests. Fix anything that fails, and tell me what you changed." />
          </label>
        )}
        {(form.actionKind === 'request' || form.actionKind === 'next_todo') && (
          <div className="schedule-modes" role="radiogroup" aria-label="Mode">
            {(form.actionKind === 'request' ? (['build', 'plan', 'ask'] as const) : (['build', 'plan'] as const)).map((m) => (
              <label key={m} className="schedule-mode">
                <input type="radio" checked={form.mode === m} onChange={() => set({ mode: m })} />
                <span>
                  {m === 'build' ? 'Build' : m === 'plan' ? 'Plan first' : 'Ask'}
                  <small>
                    {m === 'build' ? 'Makes the changes (Undo works as usual)' : m === 'plan' ? 'Proposes a plan and waits for your approval' : "Answers without changing anything"}
                  </small>
                </span>
              </label>
            ))}
          </div>
        )}
        {form.actionKind === 'site_check' && (
          <>
            <label className="settings-field">
              Web address
              <input value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.com/" />
            </label>
            <label className="settings-field">
              If it goes down, ask Claude (optional, once per outage)
              <textarea rows={2} value={form.onDown} onChange={(e) => set({ onDown: e.target.value })} placeholder="e.g. The site is down. Check the server logs and tell me what you find; don't change anything on the server." />
            </label>
          </>
        )}

        <label className="settings-field">
          When
          <select value={form.whenKind} onChange={(e) => set({ whenKind: e.target.value as WhenKind })}>
            {form.actionKind !== 'site_check' && <option value="daily">At a time of day</option>}
            <option value="every">Every few {form.actionKind === 'site_check' ? 'minutes' : 'hours'}</option>
            {form.actionKind !== 'site_check' && <option value="once">Once</option>}
            {form.actionKind !== 'deploy' && <option value="after_deploy">After each Deploy</option>}
          </select>
        </label>
        {form.whenKind === 'daily' && (
          <div className="schedule-when">
            <input type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} aria-label="Time" />
            <div className="schedule-days">
              {DAY_NAMES.map((d, i) => (
                <button key={d} type="button" className={form.days.includes(i) ? 'active' : ''} onClick={() => set({ days: form.days.includes(i) ? form.days.filter((x) => x !== i) : [...form.days, i] })}>
                  {d}
                </button>
              ))}
            </div>
            <div className="schedule-day-presets">
              <button type="button" className="chat-inline-action" onClick={() => set({ days: [0, 1, 2, 3, 4, 5, 6] })}>Every day</button>
              <button type="button" className="chat-inline-action" onClick={() => set({ days: WEEKDAYS })}>Weekdays</button>
            </div>
          </div>
        )}
        {form.whenKind === 'every' && (
          <div className="schedule-when">
            Every{' '}
            <input type="number" min={1} value={form.everyAmount} onChange={(e) => set({ everyAmount: Math.max(1, Number(e.target.value) || 1) })} aria-label="How often" />{' '}
            <select value={form.everyUnit} onChange={(e) => set({ everyUnit: e.target.value as Form['everyUnit'] })}>
              {form.actionKind === 'site_check' && <option value="minutes">minutes</option>}
              <option value="hours">hours</option>
            </select>
          </div>
        )}
        {form.whenKind === 'once' && (
          <div className="schedule-when">
            <input type="datetime-local" value={form.at} onChange={(e) => set({ at: e.target.value })} aria-label="Date and time" />
          </div>
        )}

        {ai && (
          <div className="schedule-limits">
            <label className="settings-field">
              At most
              <span>
                <input type="number" min={1} max={24} value={form.maxPerDay} onChange={(e) => set({ maxPerDay: Number(e.target.value) || 1 })} /> runs a day
              </span>
            </label>
            <label className="settings-field">
              Skip when Claude&apos;s plan usage is at
              <span>
                <input type="number" min={0} max={100} value={form.skipAboveUsage} onChange={(e) => set({ skipAboveUsage: Number(e.target.value) || 0 })} />% or more (0 = never skip)
              </span>
            </label>
          </div>
        )}

        <label className="settings-field">
          Name
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={describeAction(fromForm(form).action).slice(0, 60)} />
        </label>

        <p className="modal-muted">
          Schedules run while VibeApp is running on this computer (in the tray is enough). One that was missed while it was off runs when
          VibeApp starts, if it&apos;s less than 3 hours late. If the project is busy, it waits its turn.
        </p>
        <div className="modal-actions">
          <button className="modal-primary" disabled={saving} onClick={save}>
            {form.id ? 'Save' : 'Add schedule'}
          </button>
          <button onClick={() => setForm(null)}>Cancel</button>
        </div>
      </div>
    )
  } else {
    const ordered = [...list].sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1 : 0))
    body = (
      <>
        {list.length === 0 && (
          <p className="modal-text">
            Run something on a schedule: a request to Claude (say, run the tests every morning), the next to-do, Deploy, or a check
            that the site is up. Each run shows in the chat marked ⏰, and your phone hears how it went if phone alerts are on. You can
            also just ask Claude in the chat, for example &quot;every weekday at 7am run the tests and tell me what failed&quot;.
          </p>
        )}
        <ul className="schedule-list">
          {ordered.map((s) => (
            <li key={s.id} className={`schedule-item${s.enabled ? '' : ' schedule-off'}${s.confirmed ? '' : ' schedule-draft'}`}>
              <div className="schedule-head">
                <strong>⏰ {s.name}</strong>
                {s.confirmed ? (
                  <label className="schedule-switch" title={s.enabled ? 'On' : 'Off'}>
                    <input type="checkbox" checked={s.enabled} onChange={(e) => act(() => window.vibe.schedules.setEnabled(s.id, e.target.checked))} /> On
                  </label>
                ) : (
                  <span className="schedule-badge">Draft from Claude</span>
                )}
              </div>
              <div className="schedule-what">{describeAction(s.action)}</div>
              <div className="schedule-when-line">
                {describeWhen(s.when)}
                {s.enabled && s.nextAt ? ` · next ${ago(s.nextAt)}` : ''}
                {s.action.kind === 'site_check' && s.siteUp !== undefined ? ` · ${s.siteUp ? 'up' : 'DOWN'} at the last check` : ''}
              </div>
              {s.runs.length > 0 && (
                <ul className="schedule-runs">
                  {s.runs.slice(0, 3).map((r) => (
                    <li key={r.at} className={`schedule-run-${r.status}`}>
                      {RUN_MARK[r.status]} {ago(r.at)}: {RUN_WORD[r.status]}
                      {r.trigger === 'late' ? ' (late)' : r.trigger === 'manual' ? ' (run by hand)' : ''}
                      {r.detail ? ` — ${r.detail}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              <div className="schedule-actions">
                {!s.confirmed && (
                  <button className="modal-primary" onClick={() => act(() => window.vibe.schedules.setEnabled(s.id, true))}>
                    Looks right, turn it on
                  </button>
                )}
                {s.confirmed && <button className="chat-inline-action" onClick={() => runNow(s)}>Run now</button>}
                <button className="chat-inline-action" onClick={() => setForm(toForm(s))}>Edit</button>
                <button
                  className="chat-inline-action"
                  onClick={() => window.confirm(`Delete the schedule "${s.name}"?`) && act(() => window.vibe.schedules.remove(s.id))}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        {note && <p className="modal-muted">{note}</p>}
        <div className="modal-actions">
          <button className="modal-primary" onClick={() => setForm(blankForm())}>
            + New schedule
          </button>
        </div>
      </>
    )
  }

  return (
    <Modal title={form ? (form.id ? 'Change schedule' : 'New schedule') : 'Schedules'} onClose={onClose} wide>
      {body}
    </Modal>
  )
}

export default ScheduleDialog
