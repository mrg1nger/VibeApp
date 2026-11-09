import { useCallback, useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'

interface ClineSettingsProps {
  settings: AppSettings
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
}

/**
 * ClinePass models seen working, with the background-job eval's scores (5 memory-saving cases,
 * 2026-11-09; Haiku also 5/5). The list changes; any model id Cline accepts can be typed.
 */
const SUGGESTED = [
  { value: 'cline-pass/qwen3.7-plus', label: 'Qwen3.7 Plus: 5/5 in the memory test, ~6 s' },
  { value: 'cline-pass/glm-5.3-flash', label: 'GLM-5.3 Flash: 5/5 in the memory test, ~6 s' },
  { value: 'cline-pass/deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash: 4/5, fastest (~4 s)' }
]

type Status = { installed: boolean; version?: string; unavailable?: string }

/** Cline: a third agent on the user's own ClinePass plan, for hand-offs and VibeApp's background jobs. */
function ClineSettings({ settings, onSettingsChange }: ClineSettingsProps) {
  const [status, setStatus] = useState<Status | null>(null)
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null)
  const [model, setModel] = useState(settings.clineModel ?? '')
  const [helperModel, setHelperModel] = useState(settings.clineHelperModel ?? '')

  useEffect(() => {
    window.vibe.cline
      .status()
      .then(setStatus)
      .catch(() => setStatus({ installed: false }))
  }, [])

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

  const save = (key: 'clineModel' | 'clineHelperModel', value: string): void => {
    const next = value.trim() || null
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

      <label className="settings-field">
        <span>Model for hand-offs</span>
        <input
          list="cline-models"
          value={model}
          placeholder="Cline's own default"
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => save('clineModel', model)}
        />
      </label>
      <label className="settings-field">
        <span>Model for background jobs</span>
        <input
          list="cline-models"
          value={helperModel}
          placeholder="Same as hand-offs"
          onChange={(e) => setHelperModel(e.target.value)}
          onBlur={() => save('clineHelperModel', helperModel)}
        />
      </label>
      <datalist id="cline-models">
        {SUGGESTED.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </datalist>
    </section>
  )
}

export default ClineSettings
