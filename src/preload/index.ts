import { contextBridge, ipcRenderer } from 'electron'

const vibeApi = {
  ping: (): Promise<string> => ipcRenderer.invoke('vibe:ping')
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
