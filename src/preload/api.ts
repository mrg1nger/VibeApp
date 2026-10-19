import type {
  AppSettings,
  CheckpointRecord,
  CliName,
  CliStatus,
  ConfirmationRequest,
  ImageAttachment,
  MemoryCategory,
  MemoryFact,
  MemoryScope,
  MemoryTidyResult,
  ModelOption,
  CodexModelList,
  PickedElement,
  PreviewProblem,
  PreviewState,
  ProjectRecord,
  RemoteStatus,
  PublishStatus,
  QuestionAnswers,
  SecretSummary,
  ExtensionInfo,
  TalkAgent,
  TalkConversation,
  TalkSummary,
  ExtensionDraft,
  ExtensionCatalogItem,
  ThemeDefinition,
  TranscriptEntry,
  UsageSnapshot,
  UsageSummaryRow,
  VibeEvent
} from '@shared/types'

// Everything the screens can ask of the app, as one definition shared by the
// desktop app (Electron's IPC, see index.ts) and a web browser (Remote access,
// where the same calls travel over a WebSocket, see src/remote-bridge).

/** The part of Electron's ipcRenderer this uses; the browser bridge provides the same. */
export interface IpcLike {
  invoke(channel: string, ...args: unknown[]): Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (event: any, ...args: any[]) => void): void // eslint-disable-line @typescript-eslint/no-explicit-any
  removeListener(channel: string, listener: (event: any, ...args: any[]) => void): void // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function createVibeApi(ipcRenderer: IpcLike, host: 'electron' | 'browser') {
  return {
      /** Where the screens are running: the desktop app, or a web browser through Remote access. */
      host,

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
        ipcRenderer.invoke('vibe:project:pickNewFolder'),
      /** Takes a project off the list (its folder is never touched); erase also deletes VibeApp's data for it. */
      remove: (projectId: string, erase: boolean): Promise<ProjectRecord[]> =>
        ipcRenderer.invoke('vibe:project:remove', projectId, erase),
      /** For the browser, which has no folder dialogs: open or create a project by folder path. */
      openFolder: (folder: string): Promise<ProjectRecord> => ipcRenderer.invoke('vibe:project:openFolder', folder),
      createFolder: (parent: string, name: string): Promise<ProjectRecord> =>
        ipcRenderer.invoke('vibe:project:createFolder', parent, name)
    },

    fs: {
      /** Folders inside `dir` on the computer running VibeApp (drives and home when empty). */
      listDirs: (dir?: string): Promise<{ path: string; parent: string | null; dirs: { name: string; path: string }[] }> =>
        ipcRenderer.invoke('vibe:fs:listDirs', dir)
    },

    remote: {
      status: (): Promise<RemoteStatus> => ipcRenderer.invoke('vibe:remote:status'),
      /** Starts, stops or restarts Remote access to match the settings. */
      apply: (): Promise<RemoteStatus> => ipcRenderer.invoke('vibe:remote:apply'),
      rotateCode: (): Promise<RemoteStatus> => ipcRenderer.invoke('vibe:remote:rotateCode'),
      revoke: (deviceId: string): Promise<RemoteStatus> => ipcRenderer.invoke('vibe:remote:revoke', deviceId),
      revokeAll: (): Promise<RemoteStatus> => ipcRenderer.invoke('vibe:remote:revokeAll'),
      /** In a browser: where a project's live preview is relayed. */
      previewUrl: (projectId: string): Promise<{ port: number; secure: boolean } | null> =>
        ipcRenderer.invoke('vibe:remote:previewUrl', projectId)
    },

    chat: {
      send: (
        projectId: string,
        projectPath: string,
        text: string,
        picked?: PickedElement,
        images?: ImageAttachment[],
        forceBuild?: boolean,
        extra?: { mode?: 'build' | 'plan'; approvedPlan?: string }
      ): Promise<{ snapshot?: string; thumbnails: string[] }> =>
        ipcRenderer.invoke('vibe:chat:send', projectId, projectPath, text, picked, images, forceBuild, extra),
      planDecided: (projectId: string, toolUseId: string, decision: 'approved' | 'revised' | 'cancelled'): Promise<void> =>
        ipcRenderer.invoke('vibe:chat:planDecided', projectId, toolUseId, decision),
      undo: (
        projectPath: string,
        snapshot: string,
        projectId?: string,
        kind?: 'undo' | 'redo',
        request?: string
      ): Promise<{ redoSnapshot: string; changedFiles: string[] }> =>
        ipcRenderer.invoke('vibe:chat:undo', projectPath, snapshot, projectId, kind, request),
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
      respondToConfirmation: (
        projectId: string,
        confirmationId: string,
        approved: boolean,
        answers?: QuestionAnswers
      ): void => ipcRenderer.send('vibe:chat:confirmationResponse', projectId, confirmationId, approved, answers),
      skipReview: (projectId: string): void => ipcRenderer.send('vibe:chat:skipReview', projectId),
      stop: (projectId: string): Promise<void> => ipcRenderer.invoke('vibe:chat:stop', projectId),
      compactNow: (
        projectId: string,
        projectPath: string
      ): Promise<{ ok: boolean; message?: string; before?: number; after?: number }> =>
        ipcRenderer.invoke('vibe:chat:compactNow', projectId, projectPath),
      rotateNow: (projectId: string, projectPath: string): Promise<{ ok: boolean; message?: string }> =>
        ipcRenderer.invoke('vibe:chat:rotateNow', projectId, projectPath),
      contextSize: (projectId: string): Promise<number> => ipcRenderer.invoke('vibe:chat:contextSize', projectId),
      ask: (projectId: string, projectPath: string, text: string): Promise<void> =>
        ipcRenderer.invoke('vibe:chat:ask', projectId, projectPath, text),
      takeover: (projectId: string, projectPath: string): Promise<void> =>
        ipcRenderer.invoke('vibe:chat:takeover', projectId, projectPath),
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
      list: (projectId: string, scope: MemoryScope, includeForgotten = false): Promise<MemoryFact[]> =>
        ipcRenderer.invoke('vibe:memory:list', projectId, scope, includeForgotten),
      add: (
        projectId: string,
        scope: MemoryScope,
        text: string,
        category?: MemoryCategory,
        key?: boolean
      ): Promise<MemoryFact> => ipcRenderer.invoke('vibe:memory:add', projectId, scope, text, category, key),
      update: (
        id: string,
        patch: { text?: string; category?: MemoryCategory; key?: boolean }
      ): Promise<MemoryFact | null> => ipcRenderer.invoke('vibe:memory:update', id, patch),
      forget: (id: string): Promise<boolean> => ipcRenderer.invoke('vibe:memory:forget', id),
      restore: (id: string): Promise<boolean> => ipcRenderer.invoke('vibe:memory:restore', id),
      delete: (id: string): Promise<boolean> => ipcRenderer.invoke('vibe:memory:delete', id),
      tidy: (projectId: string, scope: MemoryScope): Promise<MemoryTidyResult> =>
        ipcRenderer.invoke('vibe:memory:tidy', projectId, scope)
    },

    settings: {
      get: (): Promise<AppSettings> => ipcRenderer.invoke('vibe:settings:get'),
      update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
        ipcRenderer.invoke('vibe:settings:update', patch)
    },

    models: {
      claude: (): Promise<ModelOption[]> => ipcRenderer.invoke('vibe:models:claude'),
      codex: (): Promise<CodexModelList> => ipcRenderer.invoke('vibe:models:codex')
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

    talk: {
      list: (): Promise<TalkSummary[]> => ipcRenderer.invoke('vibe:talk:list'),
      load: (id: string): Promise<TalkConversation | null> => ipcRenderer.invoke('vibe:talk:load', id),
      send: (id: string, text: string, agent: TalkAgent): Promise<TalkConversation> =>
        ipcRenderer.invoke('vibe:talk:send', id, text, agent),
      stop: (id: string): Promise<void> => ipcRenderer.invoke('vibe:talk:stop', id),
      delete: (id: string): Promise<void> => ipcRenderer.invoke('vibe:talk:delete', id)
    },

    brief: {
      get: (projectId: string): Promise<{ text: string; updatedAt: string } | null> =>
        ipcRenderer.invoke('vibe:memory:brief', projectId),
      refresh: (projectId: string, projectPath: string): Promise<{ text: string; updatedAt: string } | null> =>
        ipcRenderer.invoke('vibe:memory:refreshBrief', projectId, projectPath)
    },

    extensions: {
      list: (): Promise<{ installed: ExtensionInfo[]; catalog: ExtensionCatalogItem[]; nodeAvailable: boolean }> =>
        ipcRenderer.invoke('vibe:extensions:list'),
      add: (draft: ExtensionDraft): Promise<ExtensionInfo> => ipcRenderer.invoke('vibe:extensions:add', draft),
      setEnabled: (id: string, enabled: boolean): Promise<void> =>
        ipcRenderer.invoke('vibe:extensions:setEnabled', id, enabled),
      setEnv: (id: string, env: Record<string, string>): Promise<void> =>
        ipcRenderer.invoke('vibe:extensions:setEnv', id, env),
      remove: (id: string): Promise<void> => ipcRenderer.invoke('vibe:extensions:remove', id)
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
      vercelLogin: (): Promise<string> => ipcRenderer.invoke('vibe:publish:vercelLogin'),
      vercel: (projectId: string, projectPath: string, includeSecrets: boolean): Promise<string> =>
        ipcRenderer.invoke('vibe:publish:vercel', projectId, projectPath, includeSecrets),
      vercelResult: (sessionId: string): Promise<string | null> =>
        ipcRenderer.invoke('vibe:publish:vercelResult', sessionId)
    },

    usage: {
      get: (cli: CliName, force?: boolean): Promise<UsageSnapshot> =>
        ipcRenderer.invoke('vibe:usage:get', cli, force),
      /** Tokens by kind of work over the last N days (from VibeApp's own log). */
      summary: (days: number): Promise<UsageSummaryRow[]> => ipcRenderer.invoke('vibe:usage:summary', days)
    }
  }
}

export type VibeApi = ReturnType<typeof createVibeApi>
