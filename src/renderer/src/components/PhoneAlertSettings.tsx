import { useState } from 'react'
import type { AppSettings } from '@shared/types'

interface PhoneAlertSettingsProps {
  settings: AppSettings
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
  onError: (message: string) => void
}

const clean = (err: unknown): string => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Alerts on the phone through the free ntfy app. */
function PhoneAlertSettings({ settings, onSettingsChange, onError }: PhoneAlertSettingsProps) {
  const [server, setServer] = useState(settings.phoneAlertServer)
  const [testResult, setTestResult] = useState<string | null>(null)
  const topic = settings.phoneAlertTopic
  const url = topic ? `${(settings.phoneAlertServer || 'https://ntfy.sh').replace(/\/+$/, '')}/${topic}` : ''

  const turnOn = async (on: boolean): Promise<void> => {
    try {
      if (on && !topic) await window.vibe.phone.setup()
      await onSettingsChange({ phoneAlerts: on })
    } catch (err) {
      onError(clean(err))
    }
  }

  return (
    <>
      <label className="settings-toggle">
        <input type="checkbox" checked={settings.phoneAlerts} onChange={(e) => void turnOn(e.target.checked)} />
        <span>
          Alerts on my phone (ntfy)
          <small>
            When no VibeApp window is open on this computer: a plan ready, Claude asking permission or a question, Codex offered
            while Claude is out, a long request finished, a deploy done or failed. Messages only say the project's name and what's
            waiting, never code or chat text. They go through ntfy.sh (or your own ntfy server).
          </small>
        </span>
      </label>
      {settings.phoneAlerts && topic && (
        <div className="phone-setup">
          <ol>
            <li>Install the free <strong>ntfy</strong> app on your phone (App Store or Google Play).</li>
            <li>
              In the app, tap <strong>+</strong> and subscribe to this topic:{' '}
              <code className="phone-topic">{topic}</code>{' '}
              <button className="chat-inline-action" onClick={() => void navigator.clipboard?.writeText(topic)}>
                Copy
              </button>
              {settings.phoneAlertServer && settings.phoneAlertServer !== 'https://ntfy.sh' && (
                <> (choose "Use another server" and enter {settings.phoneAlertServer})</>
              )}
            </li>
            <li>
              <button
                onClick={async () => {
                  setTestResult('Sending…')
                  const r = await window.vibe.phone.test().catch((err) => ({ ok: false, error: clean(err) }))
                  setTestResult(r.ok ? 'Sent: it should arrive on your phone within a few seconds.' : `Didn't send: ${r.error}`)
                }}
              >
                Send a test alert
              </button>{' '}
              {testResult && <span className="review-muted">{testResult}</span>}
            </li>
          </ol>
          <p className="review-muted">
            Anyone who knows the topic's name can read its alerts, so it's long and random; keep it to yourself. Or open{' '}
            <a href={url} target="_blank" rel="noreferrer">
              {url}
            </a>{' '}
            on the phone to subscribe from the browser.
          </p>
          <details className="backup-list">
            <summary>Use my own ntfy server, or a new topic</summary>
            <label className="settings-field">
              <span>ntfy server</span>
              <input
                value={server}
                placeholder="https://ntfy.sh"
                onChange={(e) => setServer(e.target.value)}
                onBlur={() => server.trim() !== settings.phoneAlertServer && onSettingsChange({ phoneAlertServer: server.trim() || 'https://ntfy.sh' }).catch(() => undefined)}
              />
            </label>
            <button
              className="chat-inline-action"
              onClick={() => {
                if (window.confirm('Make a new topic? The phone has to subscribe to the new one; the old one stops getting alerts.')) {
                  window.vibe.phone.newTopic().catch((err) => onError(clean(err)))
                }
              }}
            >
              Make a new topic
            </button>
          </details>
        </div>
      )}
    </>
  )
}

export default PhoneAlertSettings
