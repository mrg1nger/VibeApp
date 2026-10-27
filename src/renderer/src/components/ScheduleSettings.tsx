import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, Schedule } from '@shared/types'
import { describeAction, describeWhen } from '@shared/schedule'

interface ScheduleSettingsProps {
  settings: AppSettings
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
}

function when(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString([], new Date().toDateString() === d.toDateString() ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

/** Every project's schedules in one list, and one switch that pauses them all. */
function ScheduleSettings({ settings, onSettingsChange }: ScheduleSettingsProps) {
  const [list, setList] = useState<(Schedule & { projectName: string })[]>([])

  const load = useCallback(() => {
    window.vibe.schedules.all().then(setList).catch(() => undefined)
  }, [])

  useEffect(() => {
    load()
    return window.vibe.schedules.onChanged(() => load())
  }, [load])

  const sorted = [...list].sort((a, b) => {
    const at = (s: Schedule): number => (s.enabled && s.nextAt ? Date.parse(s.nextAt) : Number.MAX_SAFE_INTEGER)
    return at(a) - at(b)
  })

  return (
    <div className="schedule-settings">
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.schedulesPaused}
          onChange={(e) => onSettingsChange({ schedulesPaused: e.target.checked }).catch(() => undefined)}
        />
        <span>
          Pause all schedules
          <small>Nothing scheduled runs, in any project, and nothing missed is made up for when you turn them back on. Also in the tray menu.</small>
        </span>
      </label>
      {sorted.length === 0 ? (
        <p className="settings-hint">No schedules yet. Add one from a project&apos;s ⏰ Schedules button, or ask Claude in the chat.</p>
      ) : (
        <ul className="schedule-overview">
          {sorted.map((s) => (
            <li key={s.id} className={s.enabled && !settings.schedulesPaused ? '' : 'schedule-off'}>
              <strong>⏰ {s.name}</strong> <span className="settings-hint">({s.projectName})</span>
              <div className="settings-hint">
                {describeAction(s.action)} · {describeWhen(s.when)}
                {!s.confirmed ? ' · draft, not checked yet' : !s.enabled ? ' · off' : settings.schedulesPaused ? ' · paused' : s.nextAt ? ` · next ${when(s.nextAt)}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default ScheduleSettings
