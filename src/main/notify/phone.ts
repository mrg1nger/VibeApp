import { randomBytes } from 'crypto'
import { getSettings } from '../settings/store'
import { remoteStatus } from '../remote/server'

// Phone alerts through ntfy (https://ntfy.sh, or the user's own ntfy server):
// the user subscribes to a private topic in the ntfy app, and VibeApp posts
// short messages to it ("yay: plan ready"). Never code, chat text or secrets:
// only the project name and what's waiting.

export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh'

/** A topic nobody would guess (anyone who knows a topic's name can read it). */
export function newTopic(): string {
  return `vibeapp-${randomBytes(15).toString('base64url').replace(/[-_]/g, '').slice(0, 20).toLowerCase()}`
}

export function topicUrl(server: string, topic: string): string {
  return `${server.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`
}

/** Header values must be plain ASCII. */
const ascii = (text: string): string => text.replace(/[^\x20-\x7e]/g, '').slice(0, 200)

export async function sendPhoneAlert(title: string, body: string, opts: { force?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  const s = getSettings()
  if (!opts.force && !s.phoneAlerts) return { ok: false, error: 'Phone alerts are off.' }
  if (!s.phoneAlertTopic) return { ok: false, error: 'No ntfy topic set.' }
  const remote = remoteStatus()
  try {
    const res = await fetch(topicUrl(s.phoneAlertServer || DEFAULT_NTFY_SERVER, s.phoneAlertTopic), {
      method: 'POST',
      body: body.slice(0, 500),
      headers: {
        Title: ascii(title) || 'VibeApp',
        Tags: 'robot',
        // Tapping the alert opens VibeApp (works when the phone can reach this computer).
        ...(remote.running && remote.urls[0] ? { Click: remote.urls[0] } : {})
      },
      signal: AbortSignal.timeout(10_000)
    })
    return res.ok ? { ok: true } : { ok: false, error: `ntfy answered ${res.status}` }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
