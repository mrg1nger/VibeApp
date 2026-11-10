import { useEffect, useState } from 'react'
import type { AppSettings, UpdateState } from '@shared/types'
import { isNewer } from '@shared/update'

interface UpdateSettingsProps {
  settings: AppSettings
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
}

/** The running version, a check for a newer one on GitHub Releases, and a skipped version to bring back. */
function UpdateSettings({ settings, onSettingsChange }: UpdateSettingsProps) {
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    window.vibe.update.state().then(setUpdate).catch(() => undefined)
    return window.vibe.update.onChanged(setUpdate)
  }, [])

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      setUpdate(await window.vibe.update.check())
      setChecked(true)
    } finally {
      setChecking(false)
    }
  }

  const newer = update?.version && isNewer(update.version, update.current) ? update.version : null
  const result = !checked || !update
    ? null
    : newer
      ? { ok: true, text: `VibeApp ${newer} is available${newer === settings.skippedVersion ? ' (skipped)' : ''}.` }
      : update.error
        ? { ok: false, text: update.error }
        : { ok: true, text: "You're on the newest version." }

  return (
    <section className="settings-section">
      <h3>Updates</h3>
      <p className="settings-hint">
        VibeApp {__APP_VERSION__}.{' '}
        <a href={update?.releasesUrl ?? 'https://github.com/mrg1nger/VibeApp/releases'} target="_blank" rel="noreferrer">
          All releases
        </a>
      </p>
      {update?.canInstall === false ? (
        <p className="settings-hint">Running from source: update with git pull instead.</p>
      ) : (
        <div className="settings-row">
          <button type="button" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          {result && <span className={result.ok ? 'settings-ok' : 'settings-warn'}>{result.text}</span>}
        </div>
      )}
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={settings.updateChecks}
          onChange={(e) => onSettingsChange({ updateChecks: e.target.checked }).catch(() => undefined)}
        />
        <span>
          Look for new versions automatically
          <small>
            When VibeApp starts and every few hours, it asks GitHub whether there&apos;s a newer version and shows a
            banner. Nothing is downloaded until you press Update.
          </small>
        </span>
      </label>
      {settings.skippedVersion && (
        <div className="settings-row">
          <span className="settings-hint">Skipped: version {settings.skippedVersion}.</span>
          <button type="button" onClick={() => onSettingsChange({ skippedVersion: null }).catch(() => undefined)}>
            Remind me again
          </button>
        </div>
      )}
    </section>
  )
}

export default UpdateSettings
