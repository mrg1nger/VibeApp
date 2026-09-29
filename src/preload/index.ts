import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  CheckpointRecord,
  CliName,
  CliStatus,
  ConfirmationRequest,
  MemoryFact,
  MemoryScope,
  ModelOption,
  PickedElement,
  PreviewProblem,
  PreviewState,
  ProjectRecord,
  PublishStatus,
  SecretSummary,
  ThemeDefinition,
  TranscriptEntry,
  UsageSnapshot,
  VibeEvent
} from '@shared/types'

const vibeApi = {
  ping: (): Promise<string> => ipcRenderer.invoke('vibe:ping'),

  auth: {
    check: (cli: CliName): Promise<CliStatus> => ipcRenderer.invoke('vibe:auth:check', cli),
    login: (cli: CliName): Promise<string> => ipcRenderer.invoke('vibe:auth:login', cli),
    checkNode: (): Promise<boolean> => ipcRenderer.invoke('vibe:auth:checkNode'),
    installNode: (): Promise<string> => ipcRenderer.invoke('vibe:auth:installNode'),
    checkGit: (): Promise<boolean> => ipcRenderer.invoke('vibe:auth:checkGit'),
    installGit: (): Promise<string> => ipcRenderer.invoke('vibe:auth:installGit'),
    install: (cli: CliName): Promise<string> => ipcRenderer.invoke('vibe:auth:install', cli)
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

  install: {
    onData: (cb: (sessionId: string, data: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, sessionId: string, data: string): void =>
        cb(sessionId, data)
      ipcRenderer.on('vibe:install:data', listener)
      return () => ipcRenderer.removeListener('vibe:install:data', listener)
    },
    onExit: (cb: (sessionId: string, exitCode: number) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        sessionId: string,
        exitCode: number
      ): void => cb(sessionId, exitCode)
      ipcRenderer.on('vibe:install:exit', listener)
      return () => ipcRenderer.removeListener('vibe:install:exit', listener)
    },
    write: (sessionId: string, data: string): void =>
      ipcRenderer.send('vibe:install:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number): void =>
      ipcRenderer.send('vibe:install:resize', sessionId, cols, rows),
    dispose: (sessionId: string): void => ipcRenderer.send('vibe:install:dispose', sessionId)
  },

  project: {
    list: (): Promise<ProjectRecord[]> => ipcRenderer.invoke('vibe:project:list'),
    pickExisting: (): Promise<ProjectRecord | null> =>
      ipcRenderer.invoke('vibe:project:pickExisting'),
    pickNewFolder: (): Promise<ProjectRecord | null> =>
      ipcRenderer.invoke('vibe:project:pickNewFolder')
  },

  chat: {
    send: (
      projectId: string,
      projectPath: string,
      text: string,
      picked?: PickedElement
    ): Promise<{ snapshot?: string }> =>
      ipcRenderer.invoke('vibe:chat:send', projectId, projectPath, text, picked),
    undo: (
      projectPath: string,
      snapshot: string
    ): Promise<{ redoSnapshot: string; changedFiles: string[] }> =>
      ipcRenderer.invoke('vibe:chat:undo', projectPath, snapshot),
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
    skipReview: (projectId: string): void => ipcRenderer.send('vibe:chat:skipReview', projectId),
    pendingConfirmations: (projectId: string): Promise<ConfirmationRequest[]> =>
      ipcRenderer.invoke('vibe:chat:pendingConfirmations', projectId),
    dispose: (projectId: string): void => ipcRenderer.send('vibe:chat:dispose', projectId),
    loadTranscript: (projectId: string): Promise<TranscriptEntry[]> =>
      ipcRenderer.invoke('vibe:chat:loadTranscript', projectId),
    setGoNutzMode: (projectId: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('vibe:chat:setGoNutzMode', projectId, enabled),
    isGoNutzMode: (projectId: string): Promise<boolean> =>
      ipcRenderer.invoke('vibe:chat:isGoNutzMode', projectId)
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
  },

  memory: {
    list: (projectId: string, scope: MemoryScope): Promise<MemoryFact[]> =>
      ipcRenderer.invoke('vibe:memory:list', projectId, scope),
    add: (projectId: string, scope: MemoryScope, text: string): Promise<MemoryFact> =>
      ipcRenderer.invoke('vibe:memory:add', projectId, scope, text),
    update: (projectId: string, scope: MemoryScope, id: string, text: string): Promise<boolean> =>
      ipcRenderer.invoke('vibe:memory:update', projectId, scope, id, text),
    delete: (projectId: string, scope: MemoryScope, id: string): Promise<boolean> =>
      ipcRenderer.invoke('vibe:memory:delete', projectId, scope, id)
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('vibe:settings:get'),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('vibe:settings:update', patch)
  },

  models: {
    claude: (): Promise<ModelOption[]> => ipcRenderer.invoke('vibe:models:claude')
  },

  themes: {
    list: (): Promise<ThemeDefinition[]> => ipcRenderer.invoke('vibe:themes:list'),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('vibe:themes:delete', id),
    generate: (description: string): Promise<ThemeDefinition> =>
      ipcRenderer.invoke('vibe:themes:generate', description),
    openFolder: (): Promise<string> => ipcRenderer.invoke('vibe:themes:openFolder')
  },

  preview: {
    start: (projectId: string, projectPath: string): Promise<void> =>
      ipcRenderer.invoke('vibe:preview:start', projectId, projectPath),
    stop: (projectId: string): Promise<void> => ipcRenderer.invoke('vibe:preview:stop', projectId),
    state: (projectId: string): Promise<PreviewState> => ipcRenderer.invoke('vibe:preview:state', projectId),
    log: (projectId: string): Promise<string> => ipcRenderer.invoke('vibe:preview:log', projectId),
    onState: (cb: (projectId: string, state: PreviewState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, projectId: string, state: PreviewState): void =>
        cb(projectId, state)
      ipcRenderer.on('vibe:preview:state', listener)
      return () => ipcRenderer.removeListener('vibe:preview:state', listener)
    },
    onProblem: (cb: (projectId: string, problem: PreviewProblem) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, projectId: string, problem: PreviewProblem): void =>
        cb(projectId, problem)
      ipcRenderer.on('vibe:preview:problem', listener)
      return () => ipcRenderer.removeListener('vibe:preview:problem', listener)
    }
  },

  secrets: {
    list: (projectId: string): Promise<SecretSummary[]> => ipcRenderer.invoke('vibe:secrets:list', projectId),
    set: (projectId: string, name: string, value: string): Promise<SecretSummary> =>
      ipcRenderer.invoke('vibe:secrets:set', projectId, name, value),
    delete: (projectId: string, name: string): Promise<void> =>
      ipcRenderer.invoke('vibe:secrets:delete', projectId, name)
  },

  publish: {
    status: (projectId: string, projectPath: string): Promise<PublishStatus> =>
      ipcRenderer.invoke('vibe:publish:status', projectId, projectPath),
    github: (
      projectId: string,
      projectPath: string,
      options: { name: string; visibility: 'private' | 'public' }
    ): Promise<string> => ipcRenderer.invoke('vibe:publish:github', projectId, projectPath, options),
    ghInstall: (): Promise<string> => ipcRenderer.invoke('vibe:publish:ghInstall'),
    ghLogin: (): Promise<string> => ipcRenderer.invoke('vibe:publish:ghLogin'),
    vercel: (projectId: string, projectPath: string, includeSecrets: boolean): Promise<string> =>
      ipcRenderer.invoke('vibe:publish:vercel', projectId, projectPath, includeSecrets),
    vercelResult: (sessionId: string): Promise<string | null> =>
      ipcRenderer.invoke('vibe:publish:vercelResult', sessionId)
  },

  usage: {
    get: (cli: CliName, force?: boolean): Promise<UsageSnapshot> =>
      ipcRenderer.invoke('vibe:usage:get', cli, force)
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
