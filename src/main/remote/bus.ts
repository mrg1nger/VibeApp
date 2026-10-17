import { ipcMain, type WebContents } from 'electron'

// One registry of everything the screens can ask the app to do, shared by the
// desktop window (Electron IPC) and Remote access (browsers and the API over
// HTTP/WebSocket). Handlers are registered once, through `ipc`, and work the
// same whichever way a call arrives.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (event: any, ...args: any[]) => unknown

const invokers = new Map<string, Handler>()
const listeners = new Map<string, Handler>()

/** Drop-in for ipcMain.handle / ipcMain.on that also makes the channel callable remotely. */
export const ipc = {
  handle(channel: string, handler: Handler): void {
    ipcMain.handle(channel, handler)
    invokers.set(channel, handler)
  },
  on(channel: string, handler: Handler): void {
    ipcMain.on(channel, handler)
    listeners.set(channel, handler)
  }
}

/** Stands in for Electron's IpcMainInvokeEvent; no handler reads it. */
const REMOTE_EVENT = Object.freeze({ remote: true })

export function hasChannel(channel: string): boolean {
  return invokers.has(channel) || listeners.has(channel)
}

/** Runs an invoke-style channel for a remote caller, exactly as the window would. */
export async function invoke(channel: string, args: unknown[]): Promise<unknown> {
  const handler = invokers.get(channel)
  if (!handler) {
    const listener = listeners.get(channel)
    if (!listener) throw new Error(`Unknown action: ${channel}`)
    listener(REMOTE_EVENT, ...args)
    return undefined
  }
  return handler(REMOTE_EVENT, ...args)
}

/** Something that wants every event the app sends to its screens (a browser, the API's event stream). */
export type EventSink = (channel: string, args: unknown[]) => void
const sinks = new Set<EventSink>()

export function addEventSink(sink: EventSink): () => void {
  sinks.add(sink)
  return () => sinks.delete(sink)
}

/**
 * What the handlers send events through: the desktop window plus every
 * remote screen. Shaped like the WebContents it replaces (only `send` is used).
 */
export function broadcaster(getWindow: () => WebContents | undefined): () => WebContents | undefined {
  const fanOut = {
    send(channel: string, ...args: unknown[]): void {
      const window = getWindow()
      if (window && !window.isDestroyed()) window.send(channel, ...args)
      for (const sink of sinks) {
        try {
          sink(channel, args)
        } catch (err) {
          console.warn('Remote event delivery failed:', (err as Error).message)
        }
      }
    }
  } as unknown as WebContents
  return () => fanOut
}
