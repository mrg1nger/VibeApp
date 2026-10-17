import { contextBridge, ipcRenderer } from 'electron'
import { createVibeApi, type VibeApi } from './api'

const vibeApi = createVibeApi(ipcRenderer, 'electron')

declare global {
  interface Window {
    vibe: VibeApi
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('vibe', vibeApi)
} else {
  (window as unknown as { vibe: VibeApi }).vibe = vibeApi
}
