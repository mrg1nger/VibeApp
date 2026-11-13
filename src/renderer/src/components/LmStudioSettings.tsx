import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, LmStudioStatus } from '@shared/types'

interface LmStudioSettingsProps {
  settings: AppSettings
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
}

/** Background jobs often send a long conversation or several files; less context than this fails them. */
const SMALL_CONTEXT = 16_000

const isLocal = (url: string): boolean => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url.trim())

/** LM Studio: a model on this computer that does VibeApp's background jobs for free. */
function LmStudioSettings({ settings, onSettingsChange }: LmStudioSettingsProps) {
  const [status, setStatus] = useState<LmStudioStatus | null>(null)
  const [looking, setLooking] = useState(false)
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null)
  const [url, setUrl] = useState(settings.lmStudioUrl)
  // Follow changes made elsewhere (another window, a phone).
  useEffect(() => setUrl(settings.lmStudioUrl), [settings.lmStudioUrl])

  const look = useCallback(async () => {
    setLooking(true)
    try {
      setStatus(await window.vibe.lmStudio.status())
    } catch (err) {
      setStatus({ running: false, url: settings.lmStudioUrl, models: [], error: (err as Error).message })
    } finally {
      setLooking(false)
    }
  }, [settings.lmStudioUrl])

  useEffect(() => {
    look().catch(() => undefined)
  }, [look])

  const runCheck = useCallback(async () => {
    setChecking(true)
    setCheck(null)
    try {
      setCheck(await window.vibe.lmStudio.check())
    } catch (err) {
      setCheck({ ok: false, message: (err as Error).message })
    } finally {
      setChecking(false)
    }
  }, [])

  const saveUrl = (): void => {
    const next = url.trim() || 'http://localhost:1234'
    if (next !== settings.lmStudioUrl) onSettingsChange({ lmStudioUrl: next }).catch(() => undefined)
  }

  const models = status?.models ?? []
  const loaded = models.find((m) => m.loaded)
  const chosen = settings.lmStudioModel
  const inUse = models.find((m) => m.id === (chosen ?? loaded?.id))
  const offered = !chosen || models.some((m) => m.id === chosen)

  return (
    <section className="settings-section lmstudio-settings">
      <h3>LM Studio (a model on this computer)</h3>
      <p className="settings-hint">
        {status === null
          ? 'Looking for LM Studio…'
          : status.running
            ? models.length
              ? `LM Studio is running at ${status.url} with ${models.length} chat model${models.length === 1 ? '' : 's'}${loaded ? ` (${loaded.id} is loaded)` : ', none loaded yet'}.`
              : `LM Studio is running at ${status.url}, but has no chat model. Download one in LM Studio first.`
            : `${status.error ?? 'LM Studio isn\'t answering.'} To use it: install LM Studio, download a model, then open Developer and start the server (or run lms server start).`}
      </p>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.lmStudioHelpers}
          onChange={(e) => onSettingsChange({ lmStudioHelpers: e.target.checked }).catch(() => undefined)}
        />
        <span>
          Background jobs on LM Studio
          <small>
            Saving memory, the memory tidy-up, the project brief, file summaries and chat summaries run on your own
            computer for free, before Cline or Claude are asked. The text never leaves this computer. If LM Studio is
            closed or can't do a job, Cline or Haiku does it as before. A model of about 8B or larger with at least
            16k of context works best; smaller ones save less reliably.
          </small>
        </span>
      </label>

      <label className="settings-field">
        <span>Server address</span>
        <input value={url} placeholder="http://localhost:1234" onChange={(e) => setUrl(e.target.value)} onBlur={saveUrl} />
        {!isLocal(url) && (
          <small className="settings-warn">
            This is another computer: background jobs would send the conversation and file excerpts there.
          </small>
        )}
      </label>

      {status?.running && models.length > 0 && (
        <label className="settings-field">
          <span>Model for background jobs</span>
          <select
            value={chosen ?? ''}
            onChange={(e) => {
              const next = e.target.value || null
              if (next !== chosen) onSettingsChange({ lmStudioModel: next }).catch(() => undefined)
            }}
          >
            <option value="">The one loaded now{loaded ? ` (${loaded.id})` : ''}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.loaded ? ' (loaded)' : ''}
              </option>
            ))}
            {!offered && chosen && <option value={chosen}>{chosen} (not in LM Studio now)</option>}
          </select>
          {!offered && <small className="settings-warn">LM Studio doesn't have {chosen} now; pick another.</small>}
          {inUse && !inUse.loaded && (
            <small className="settings-hint">Not loaded yet: LM Studio loads it on the first job, which can take a minute.</small>
          )}
          {inUse?.loaded && inUse.contextLength !== undefined && inUse.contextLength < SMALL_CONTEXT && (
            <small className="settings-warn">
              It's loaded with {Math.round(inUse.contextLength / 1000)}k of context; long jobs won't fit. Load it with 16k or more.
            </small>
          )}
        </label>
      )}

      <div className="settings-row">
        <button type="button" onClick={() => look().catch(() => undefined)} disabled={looking}>
          {looking ? 'Looking…' : 'Look again'}
        </button>
        {status?.running && models.length > 0 && (
          <button type="button" onClick={runCheck} disabled={checking}>
            {checking ? 'Checking…' : 'Test LM Studio'}
          </button>
        )}
        {check && <span className={check.ok ? 'settings-ok' : 'settings-warn'}>{check.message}</span>}
      </div>
    </section>
  )
}

export default LmStudioSettings
