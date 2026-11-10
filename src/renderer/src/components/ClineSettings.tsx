import { useCallback, useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { CLINE_MODEL_NOTES, CLINE_RECOMMENDED, CLINE_TESTED_ON, clineModelLabel } from '@shared/clineModels'

interface ClineSettingsProps {
  settings: AppSettings
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
}

type Status = { installed: boolean; version?: string; unavailable?: string }
type ModelList = { models: { id: string; name: string }[]; defaultId?: string }

interface ModelPickerProps {
  label: string
  use: 'handoff' | 'helper'
  value: string | null
  /** The live list from Cline, or null while loading / when it couldn't be read. */
  list: ModelList | null
  failed: boolean
  emptyLabel: string
  onChange: (value: string | null) => void
}

/** A menu of the ClinePass models Cline offers now; a text box if the list can't be read. */
function ModelPicker({ label, use, value, list, failed, emptyLabel, onChange }: ModelPickerProps) {
  const [typed, setTyped] = useState(value ?? '')
  if (failed || !list?.models.length) {
    return (
      <label className="settings-field">
        <span>{label}</span>
        <input
          value={typed}
          placeholder={list === null && !failed ? 'Loading the models…' : emptyLabel}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => onChange(typed.trim() || null)}
        />
        {failed && <small className="settings-warn">Couldn't read the model list from Cline; type a model id (for example cline-pass/glm-5.3).</small>}
      </label>
    )
  }
  const offered = list.models.some((m) => m.id === value)
  const sorted = [...list.models].sort((a, b) => {
    const pick = (id: string): number => (CLINE_RECOMMENDED[use] === id ? 0 : CLINE_MODEL_NOTES[id]?.refused ? 2 : 1)
    return pick(a.id) - pick(b.id) || a.name.localeCompare(b.name)
  })
  return (
    <label className="settings-field">
      <span>{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{emptyLabel}</option>
        {sorted.map((m) => (
          <option key={m.id} value={m.id}>
            {clineModelLabel(m.id, m.name, use)}
          </option>
        ))}
        {value && !offered && <option value={value}>{value} (not offered by ClinePass now)</option>}
      </select>
      {value && !offered && <small className="settings-warn">ClinePass doesn't offer {value} any more; pick another.</small>}
      {value && CLINE_MODEL_NOTES[value]?.refused && <small className="settings-warn">ClinePass refused this model when it was tested ({CLINE_TESTED_ON}).</small>}
    </label>
  )
}

/** Cline: a third agent on the user's own ClinePass plan, for hand-offs and VibeApp's background jobs. */
function ClineSettings({ settings, onSettingsChange }: ClineSettingsProps) {
  const [status, setStatus] = useState<Status | null>(null)
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null)
  const [list, setList] = useState<ModelList | null>(null)
  const [listFailed, setListFailed] = useState(false)

  useEffect(() => {
    window.vibe.cline
      .status()
      .then((s) => {
        setStatus(s)
        if (!s.installed) return
        window.vibe.cline
          .models()
          .then((l) => (l.models.length ? setList(l) : setListFailed(true)))
          .catch(() => setListFailed(true))
      })
      .catch(() => setStatus({ installed: false }))
  }, [])

  const nameOf = (id: string | undefined): string | undefined => (id ? (list?.models.find((m) => m.id === id)?.name ?? id) : undefined)
  const defaultName = nameOf(list?.defaultId)

  const runCheck = useCallback(async () => {
    setChecking(true)
    setCheck(null)
    try {
      setCheck(await window.vibe.cline.check())
    } catch (err) {
      setCheck({ ok: false, message: (err as Error).message })
    } finally {
      setChecking(false)
    }
  }, [])

  const save = (key: 'clineModel' | 'clineHelperModel', next: string | null): void => {
    if (next !== settings[key]) onSettingsChange({ [key]: next }).catch(() => undefined)
  }

  return (
    <section className="settings-section cline-settings">
      <h3>Cline (ClinePass)</h3>
      <p className="settings-hint">
        {status === null
          ? 'Looking for Cline…'
          : status.installed
            ? `Cline ${status.version ?? ''} is installed.${status.unavailable ? ` Not usable right now: ${status.unavailable}` : ''}`
            : 'Cline isn\'t installed. To use it: in a terminal, run npm i -g cline, then cline auth and choose ClinePass.'}
      </p>
      {status?.installed && (
        <div className="settings-row">
          <button type="button" onClick={runCheck} disabled={checking}>
            {checking ? 'Checking…' : 'Test Cline'}
          </button>
          {check && <span className={check.ok ? 'settings-ok' : 'settings-warn'}>{check.message}</span>}
        </div>
      )}

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.clineHelpers}
          onChange={(e) => onSettingsChange({ clineHelpers: e.target.checked }).catch(() => undefined)}
        />
        <span>
          Background jobs on Cline
          <small>
            Saving memory, the memory tidy-up, the project brief, file summaries and chat summaries run on your
            ClinePass plan instead of Claude's (they were about a tenth of Claude's usage). If Cline can't do one, Haiku
            does it as before. These jobs send the conversation and file excerpts to Cline's model providers instead of
            Anthropic.
          </small>
        </span>
      </label>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.clineHandoffs}
          onChange={(e) => onSettingsChange({ clineHandoffs: e.target.checked }).catch(() => undefined)}
        />
        <span>
          Claude can hand work to Cline
          <small>
            Straightforward, well-specified work can go to Cline instead of Codex, and Cline takes a request when Claude
            and Codex are both out. VibeApp only lets Cline work inside the project: commands that delete folders, push,
            or reach outside it are refused, and so are its account connectors (Gmail, Drive and the like). Codex
            reviews what Cline changed.
          </small>
        </span>
      </label>

      {status?.installed && (
        <>
          <ModelPicker
            label="Model for hand-offs"
            use="handoff"
            value={settings.clineModel}
            list={list}
            failed={listFailed}
            emptyLabel={`ClinePass's default${defaultName ? ` (${defaultName})` : ''}`}
            onChange={(v) => save('clineModel', v)}
          />
          <ModelPicker
            label="Model for background jobs"
            use="helper"
            value={settings.clineHelperModel}
            list={list}
            failed={listFailed}
            emptyLabel="Same as hand-offs"
            onChange={(v) => save('clineHelperModel', v)}
          />
          <p className="settings-hint">
            The scores are from VibeApp's own tests ({CLINE_TESTED_ON}): "coding" is three small tasks checked by the
            project's tests, "memory" five memory-saving cases.
          </p>
        </>
      )}
    </section>
  )
}

export default ClineSettings
