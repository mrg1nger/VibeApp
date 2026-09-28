import { contextBridge, ipcRenderer } from 'electron'
import type {
  CheckpointRecord,
  CliName,
  CliStatus,
  ConfirmationRequest,
  ProjectRecord,
  TranscriptEntry,
  VibeEvent
} from '@shared/types'

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
  },

  project: {
    list: (): Promise<ProjectRecord[]> => ipcRenderer.invoke('vibe:project:list'),
    pickExisting: (): Promise<ProjectRecord | null> =>
      ipcRenderer.invoke('vibe:project:pickExisting'),
    pickNewFolder: (): Promise<ProjectRecord | null> =>
      ipcRenderer.invoke('vibe:project:pickNewFolder')
  },

  chat: {
    send: (projectId: string, projectPath: string, text: string): Promise<void> =>
      ipcRenderer.invoke('vibe:chat:send', projectId, projectPath, text),
    onEvent: (cb: (projectId: string, event: VibeEvent) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        projectId: string,
        payload: VibeEvent
      ): void => cb(projectId, payload)
      ipcRenderer.on('vibe:chat:event', listener)
      return () => ipcRenderer.removeListener('vibe:chat:event', listener)
    },
    onConfirmationRequest: (
      cb: (projectId: string, request: ConfirmationRequest) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        projectId: string,
        request: ConfirmationRequest
      ): void => cb(projectId, request)
      ipcRenderer.on('vibe:chat:confirmationRequest', listener)
      return () => ipcRenderer.removeListener('vibe:chat:confirmationRequest', listener)
    },
    respondToConfirmation: (projectId: string, confirmationId: string, approved: boolean): void =>
      ipcRenderer.send('vibe:chat:confirmationResponse', projectId, confirmationId, approved),
    dispose: (projectId: string): void => ipcRenderer.send('vibe:chat:dispose', projectId),
    loadTranscript: (projectId: string): Promise<TranscriptEntry[]> =>
      ipcRenderer.invoke('vibe:chat:loadTranscript', projectId)
  },

  git: {
    hasChanges: (projectPath: string): Promise<boolean> =>
      ipcRenderer.invoke('vibe:git:hasChanges', projectPath),
    suggestMessage: (projectPath: string): Promise<string> =>
      ipcRenderer.invoke('vibe:git:suggestMessage', projectPath),
    checkpoint: (projectPath: string, message: string): Promise<CheckpointRecord> =>
      ipcRenderer.invoke('vibe:git:checkpoint', projectPath, message),
    history: (projectPath: string): Promise<CheckpointRecord[]> =>
      ipcRenderer.invoke('vibe:git:history', projectPath),
    restore: (projectPath: string, commitHash: string): Promise<string> =>
      ipcRenderer.invoke('vibe:git:restore', projectPath, commitHash)
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
