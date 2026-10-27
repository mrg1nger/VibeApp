import { createVibeApi, type IpcLike } from '../preload/api'

// In a web browser (Remote access), this gives the page the same `window.vibe`
// the desktop app's preload does, with every call travelling over a
// WebSocket to VibeApp on the computer, and its events coming back the same way.

type Listener = (event: unknown, ...args: unknown[]) => void

const listeners = new Map<string, Set<Listener>>()
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let nextId = 0
let socket: WebSocket | null = null
let queue: string[] = []
let backoff = 500

function banner(text: string | null): void {
  let el = document.getElementById('vibe-remote-banner')
  if (!text) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('div')
    el.id = 'vibe-remote-banner'
    el.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:6px 12px;background:#7a4b00;color:#fff;font:13px system-ui,sans-serif;text-align:center'
    document.body.append(el)
  }
  el.textContent = text
}

function connect(): void {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.onopen = () => {
    socket = ws
    backoff = 500
    banner(null)
    for (const m of queue) ws.send(m)
    queue = []
  }
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data)) as {
      type?: string
      channel?: string
      args?: unknown[]
      id?: number
      ok?: boolean
      result?: unknown
      error?: string
    }
    if (m.type === 'event' && m.channel) {
      for (const l of listeners.get(m.channel) ?? []) l({}, ...(m.args ?? []))
      return
    }
    if (m.id !== undefined) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.ok) p?.resolve(m.result)
      else p?.reject(new Error(m.error ?? 'Failed'))
    }
  }
  ws.onclose = (event) => {
    socket = null
    for (const p of pending.values()) p.reject(new Error('The connection to VibeApp was lost.'))
    pending.clear()
    if (event.code === 4401) {
      location.href = '/login'
      return
    }
    // Revoked, or the server restarted with this device no longer paired?
    fetch('/api/status', { credentials: 'same-origin' })
      .then((r) => {
        if (r.status === 401) location.href = '/login'
      })
      .catch(() => undefined)
    banner('Reconnecting to VibeApp…')
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 10_000)
  }
}

function transmit(message: object): void {
  const text = JSON.stringify(message)
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(text)
  else queue.push(text)
}

const ipc: IpcLike = {
  invoke(channel, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      transmit({ id, type: 'invoke', channel, args })
    })
  },
  send(channel, ...args) {
    transmit({ type: 'send', channel, args })
  },
  on(channel, listener) {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(listener)
  },
  removeListener(channel, listener) {
    listeners.get(channel)?.delete(listener)
  }
}

;(window as unknown as { vibe: ReturnType<typeof createVibeApi> }).vibe = createVibeApi(ipc, 'browser')
connect()

// Installed as an app: shows a "can't reach VibeApp" page instead of the browser's error when the computer is off.
// (Browsers only allow this on a trusted address, so it quietly does nothing on the self-made certificate.)
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}
