import { useEffect, useState } from 'react'
import type { AppSettings, UpdateState } from '@shared/types'
import { bannerWanted } from '@shared/update'

interface UpdateBannerProps {
  settings: AppSettings
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
}

const clean = (err: unknown): string => String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * Across the top when GitHub Releases has a newer VibeApp: what's new, update (download,
 * then VibeApp restarts into the new version), skip this version, or not now.
 */
function UpdateBanner({ settings, onSettingsChange }: UpdateBannerProps) {
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  /** Projects still working when Update was pressed: ask before stopping them. */
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const remote = window.vibe.host === 'browser'

  useEffect(() => {
    window.vibe.update.state().then(setUpdate).catch(() => undefined)
    return window.vibe.update.onChanged(setUpdate)
  }, [])

  if (!update?.version || !bannerWanted(update, settings.skippedVersion) || dismissed === update.version) return null
  const { version } = update
  const failure = problem ?? (update.status === 'error' ? update.error : undefined)

  const install = async (anyway = false): Promise<void> => {
    setBusy(null)
    setProblem(null)
    try {
      await window.vibe.update.install(anyway)
    } catch (err) {
      const message = clean(err)
      if (/still working/.test(message)) setBusy(message)
      else setProblem(message)
    }
  }

  const whatsNew = (
    <a href={update.releaseUrl ?? update.releasesUrl} target="_blank" rel="noreferrer">
      What&apos;s new
    </a>
  )

  if (update.status === 'downloading' || update.status === 'ready') {
    return (
      <div className="github-banner update-banner" role="status">
        <div>
          <strong>
            {update.status === 'ready'
              ? `Installing VibeApp ${version}. It will open again in a moment…`
              : `Downloading VibeApp ${version}… ${update.percent ?? 0}%`}
          </strong>
        </div>
      </div>
    )
  }

  return (
    <div className={`github-banner update-banner${busy || failure ? ' github-banner-conflict' : ''}`} role="status">
      <div>
        {busy ? (
          <>
            <strong>{busy}</strong> Update anyway, or wait until it&apos;s done?
          </>
        ) : (
          <>
            <strong>VibeApp {version} is available</strong> (you have {update.current}). {whatsNew}
            {failure && <> · Couldn&apos;t update: {failure}</>}
            {remote && <> · Install it on the computer running VibeApp.</>}
          </>
        )}
      </div>
      <div className="github-banner-actions">
        {busy ? (
          <>
            <button className="github-banner-primary" onClick={() => install(true)}>
              Update anyway
            </button>
            <button onClick={() => setBusy(null)}>Wait</button>
          </>
        ) : (
          <>
            {!remote && update.canInstall && (
              <button className="github-banner-primary" onClick={() => install()}>
                {update.status === 'error' ? 'Try again' : 'Update and restart'}
              </button>
            )}
            <button
              title="No reminder for this version. A newer one will still show."
              onClick={() => onSettingsChange({ skippedVersion: version }).catch(() => undefined)}
            >
              Skip this version
            </button>
            <button aria-label="Not now" title="Hide until VibeApp next starts" onClick={() => setDismissed(version)}>
              Not now
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default UpdateBanner
