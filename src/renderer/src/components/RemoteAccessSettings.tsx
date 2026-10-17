import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, RemoteStatus } from '@shared/types'

interface RemoteAccessSettingsProps {
  settings: AppSettings
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
  onError: (message: string) => void
}

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`
  return new Date(iso).toLocaleDateString()
}

/** Settings for using VibeApp from a web browser and through its API (the desktop app only). */
function RemoteAccessSettings({ settings, onSettingsChange, onError }: RemoteAccessSettingsProps) {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [port, setPort] = useState(String(settings.remotePort))
  const [copied, setCopied] = useState('')

  const refresh = useCallback(() => {
    window.vibe.remote.status().then(setStatus).catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 4000)
    return () => clearInterval(timer)
  }, [refresh, settings.remoteAccess, settings.remotePort])

  if (window.vibe.host === 'browser') {
    return (
      <p className="settings-hint">
        You're using VibeApp through Remote access. Its settings (who can connect, and how) can only be changed on the
        computer running VibeApp.
      </p>
    )
  }

  const change = async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      await onSettingsChange(patch)
      setStatus(await window.vibe.remote.status())
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const copy = (text: string, what: string): void => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(what)
      setTimeout(() => setCopied(''), 1500)
    })
  }

  const on = settings.remoteAccess !== 'off'
  return (
    <div className="remote-settings">
      <label className="settings-toggle">
        <span>
          Remote access
          <small>
            Use VibeApp from a web browser (Chrome, Firefox, Edge) and let other tools, such as Claude Code, work with
            it through its API. Anyone who connects can do what you can here, including running commands on this
            computer, so each browser or tool has to be paired with a code first. Never open it to the internet; to
            reach it from outside your home, use a private network such as Tailscale.
          </small>
        </span>
        <select
          value={settings.remoteAccess}
          onChange={(e) => change({ remoteAccess: e.target.value as AppSettings['remoteAccess'] })}
        >
          <option value="off">Off</option>
          <option value="local">This computer only</option>
          <option value="lan">This computer and my local network</option>
        </select>
      </label>

      {on && (
        <>
          <label className="settings-toggle settings-subtoggle">
            <input
              type="checkbox"
              checked={settings.remoteReadOnly}
              onChange={(e) => change({ remoteReadOnly: e.target.checked })}
            />
            <span>
              Read-only
              <small>Connected browsers and tools can watch the chats, memory and usage, but can't send, change or run anything.</small>
            </span>
          </label>

          <label className="settings-field settings-subtoggle">
            Port
            <input
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
              onBlur={() => {
                const n = Number(port)
                if (n >= 1024 && n <= 65535 && n !== settings.remotePort) change({ remotePort: n })
                else setPort(String(settings.remotePort))
              }}
            />
          </label>

          {status?.error && <p className="chat-error">{status.error}</p>}

          {status?.running && (
            <div className="remote-box">
              <div>
                <strong>Open in a browser:</strong>
                <ul className="remote-urls">
                  {status.urls.map((u) => (
                    <li key={u}>
                      <code>{u}</code>{' '}
                      <button className="chat-inline-action" onClick={() => copy(u, u)}>
                        {copied === u ? 'Copied' : 'Copy'}
                      </button>
                    </li>
                  ))}
                </ul>
                {settings.remoteAccess === 'lan' && (
                  <small className="settings-hint">
                    The connection is encrypted with a certificate VibeApp made itself, so the browser warns the first
                    time; choose to continue (Advanced, then Proceed).
                  </small>
                )}
              </div>
              <div className="remote-code">
                <span>Pairing code</span>
                <code>{status.pairingCode}</code>
                <button className="chat-inline-action" onClick={() => window.vibe.remote.rotateCode().then(setStatus)}>
                  New code
                </button>
                <small className="settings-hint">Each code works once: after a device pairs, a new one appears here.</small>
              </div>
              <div>
                <strong>Claude Code:</strong> run this once to give Claude Code VibeApp&apos;s tools (list projects, send
                messages, read chats and memory):
                <div className="remote-command">
                  <code>{status.mcpCommand}</code>{' '}
                  <button className="chat-inline-action" onClick={() => copy(status.mcpCommand, 'mcp')}>
                    {copied === 'mcp' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {status && status.devices.length > 0 && (
            <div className="remote-devices">
              <strong>Paired devices</strong>
              <ul>
                {status.devices.map((d) => (
                  <li key={d.id}>
                    <span className={`remote-dot${d.online ? ' online' : ''}`} title={d.online ? 'Connected now' : 'Not connected'} />
                    <span className="remote-device-name">{d.name}</span>
                    <small className="settings-hint">
                      {d.readOnly ? 'read-only · ' : ''}
                      {d.online ? 'connected now' : `last seen ${ago(d.lastSeen)}`}
                    </small>
                    <button className="chat-inline-action" onClick={() => window.vibe.remote.revoke(d.id).then(setStatus)}>
                      Disconnect
                    </button>
                  </li>
                ))}
              </ul>
              <button
                className="chat-inline-action"
                onClick={() => {
                  if (window.confirm('Disconnect every paired browser and tool? They will need a new code.')) {
                    window.vibe.remote.revokeAll().then(setStatus)
                  }
                }}
              >
                Disconnect all
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default RemoteAccessSettings
