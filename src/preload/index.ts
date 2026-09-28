import { contextBridge, ipcRenderer } from 'electron'
import type { CliName, CliStatus } from '@shared/types'

const vibeApi = {
  ping: (): Promise<string> => ipcRenderer.invoke('vibe:ping'),

  auth: {
    check: (cli: CliName): Promise<CliStatus> => ipcRenderer.invoke('vibe:auth:check', cli),
    login: (cli: CliName): Promise<string> => ipcRenderer.invoke('vibe:auth:login', cli)
  },

  login: {
    onData: (cb: (sessionId: string, data: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, sessionId: string, data: string): void =>
        cb(sessionId, data)
      ipcRenderer.on('vibe:login:data', listener)
      return () => ipcRenderer.removeListener('vibe:login:data', listener)
    },
    onExit: (cb: (sessionId: string, exitCode: number) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        sessionId: string,
        exitCode: number
      ): void => cb(sessionId, exitCode)
      ipcRenderer.on('vibe:login:exit', listener)
      return () => ipcRenderer.removeListener('vibe:login:exit', listener)
    },
    write: (sessionId: string, data: string): void =>
      ipcRenderer.send('vibe:login:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number): void =>
      ipcRenderer.send('vibe:login:resize', sessionId, cols, rows),
    dispose: (sessionId: string): void => ipcRenderer.send('vibe:login:dispose', sessionId)
  }
}

declare global {
  interface Window {
    vibe: typeof vibeApi
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('vibe', vibeApi)
} else {
  (window as unknown as { vibe: typeof vibeApi }).vibe = vibeApi
}
