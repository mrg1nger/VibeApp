import { ipcMain, dialog, shell, type WebContents } from 'electron'
import { mkdirSync } from 'fs'
import type {
  AppSettings,
  CliName,
  ConfirmationRequest,
  MemoryScope,
  PickedElement,
  PreviewProblem,
  PreviewState,
  VibeEvent
} from '@shared/types'
import { checkClaudeStatus } from '../cli/claude'
import { checkCodexStatus } from '../cli/codex'
import { isCliOnPath, refreshPathFromRegistry } from '../cli/execCli'
import { startLoginSession, getLoginSession, disposeLoginSession } from '../pty/loginSession'
import {
  startInstallSession,
  startNodeInstallSession,
  startGitInstallSession,
  startGhInstallSession,
  startTerminalSession,
  getInstallSession,
  disposeInstallSession
} from '../pty/installSession'
import type { PtySession } from '../pty/ptySession'
import {
  listProjects,
  recordProjectOpened,
  setSdkSessionId,
  getProject,
  setGoNutzMode,
  setDeployUrl
} from '../projects/store'
import { appendUserMessage, appendEvent, loadTranscript } from '../projects/transcript'
import {
  ensureRepo,
  hasUncommittedChanges,
  suggestCheckpointMessage,
  checkpoint,
  history,
  restoreCheckpoint
} from '../git/repo'
import {
  getOrCreateSession,
  getSession,
  disposeSession,
  setModelForAllSessions
} from '../orchestrator/session'
import { addFact, listFacts, deleteFact, updateFact } from '../memory/storage'
import { projectMemoryPath, globalMemoryPath } from '../memory/paths'
import { getSettings, updateSettings } from '../settings/store'
import { listClaudeModels } from '../cli/claudeModels'
import { listThemes, deleteTheme, themesDir } from '../themes/store'
import { generateTheme } from '../themes/generate'
import { getUsage } from '../usage/usage'
import { takeSnapshot, restoreSnapshot } from '../git/snapshots'
import { routeMessage } from '../orchestrator/routing'
import { getPreview, findPreview, previewEvents } from '../preview/preview'
import { beginTurn, handleSessionEvent, skipReview } from '../review/reviewFlow'
import { listSecrets, setSecret, deleteSecret } from '../secrets/vault'
import {
  publishStatus,
  publishToGitHub,
  ghLoginSessionOptions,
  vercelDeploySessionOptions,
  vercelLoginSessionOptions,
  parseVercelLoginUrl,
  parseVercelUrl
} from '../publish/publish'

export function registerIpcHandlers(getSender: () => WebContents | undefined): void {
  ipcMain.handle('vibe:ping', () => 'pong')

  ipcMain.handle('vibe:auth:check', async (_event, cli: CliName) => {
    return cli === 'claude' ? checkClaudeStatus() : checkCodexStatus()
  })

  ipcMain.handle('vibe:auth:login', async (_event, cli: CliName) => {
    const session = startLoginSession(cli)

    session.on('data', (data: string) => {
      getSender()?.send('vibe:login:data', session.id, data)
    })
    session.on('exit', (exitCode: number) => {
      getSender()?.send('vibe:login:exit', session.id, exitCode)
    })

    return session.id
  })

  ipcMain.on('vibe:login:write', (_event, sessionId: string, data: string) => {
    getLoginSession(sessionId)?.write(data)
  })

  ipcMain.on('vibe:login:resize', (_event, sessionId: string, cols: number, rows: number) => {
    getLoginSession(sessionId)?.resize(cols, rows)
  })

  ipcMain.on('vibe:login:dispose', (_event, sessionId: string) => {
    disposeLoginSession(sessionId)
  })

  function wireInstallSession(session: PtySession): string {
    session.on('data', (data: string) => {
      getSender()?.send('vibe:install:data', session.id, data)
    })
    session.on('exit', async (exitCode: number) => {
      await refreshPathFromRegistry()
      getSender()?.send('vibe:install:exit', session.id, exitCode)
    })
    return session.id
  }

  ipcMain.handle('vibe:auth:checkNode', () => isCliOnPath('node'))
  ipcMain.handle('vibe:auth:checkGit', () => isCliOnPath('git'))

  ipcMain.handle('vibe:auth:installNode', () => wireInstallSession(startNodeInstallSession()))
  ipcMain.handle('vibe:auth:installGit', () => wireInstallSession(startGitInstallSession()))

  ipcMain.handle('vibe:auth:install', (_event, cli: CliName) =>
    wireInstallSession(startInstallSession(cli))
  )

  ipcMain.on('vibe:install:write', (_event, sessionId: string, data: string) => {
    getInstallSession(sessionId)?.write(data)
  })

  ipcMain.on('vibe:install:resize', (_event, sessionId: string, cols: number, rows: number) => {
    getInstallSession(sessionId)?.resize(cols, rows)
  })

  ipcMain.on('vibe:install:dispose', (_event, sessionId: string) => {
    disposeInstallSession(sessionId)
  })

  ipcMain.handle('vibe:project:list', () => listProjects())

  ipcMain.handle('vibe:project:pickExisting', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const projectPath = result.filePaths[0]
    await ensureRepo(projectPath)
    return recordProjectOpened(projectPath)
  })

  ipcMain.handle('vibe:project:pickNewFolder', async () => {
    const result = await dialog.showSaveDialog({ properties: ['createDirectory'] })
    if (result.canceled || !result.filePath) return null
    mkdirSync(result.filePath, { recursive: true })
    await ensureRepo(result.filePath)
    return recordProjectOpened(result.filePath)
  })

  ipcMain.handle(
    'vibe:chat:send',
    async (_event, projectId: string, projectPath: string, text: string, picked?: PickedElement) => {
      const project = getProject(projectId)
      const session = getOrCreateSession(
        projectId,
        projectPath,
        project?.sdkSessionId,
        project?.goNutzMode ?? false
      )
      wireSessionEvents(session, projectId, getSender)

      // Snapshot first so "Undo" can put the files back exactly as they
      // were before this message. A failure only costs the undo button.
      let snapshot: string | undefined
      try {
        snapshot = await takeSnapshot(projectPath, text)
      } catch (err) {
        console.warn('Snapshot failed:', (err as Error).message)
      }

      const route = routeMessage(text, getSettings())
      try {
        await session.useModel(route.model)
      } catch (err) {
        console.warn('Model switch failed:', (err as Error).message)
      }

      // Quick edits skip the Codex review: it would take longer than the edit.
      beginTurn(projectId, { projectPath, request: text, snapshot, skipReview: route.model === 'haiku' })
      appendUserMessage(projectId, text, { snapshot, attachment: picked ? describePicked(picked) : undefined })
      if (route.label) {
        session.emit('event', { type: 'route', label: route.label, reason: route.reason ?? '' } satisfies VibeEvent)
      }
      const message = [route.note, picked ? pickedNote(picked) : undefined, text].filter(Boolean).join('\n\n')
      session.send(message)
      return { snapshot }
    }
  )

  ipcMain.handle('vibe:chat:undo', (_event, projectPath: string, snapshot: string) =>
    restoreSnapshot(projectPath, snapshot)
  )

  ipcMain.on('vibe:chat:skipReview', (_event, projectId: string) => skipReview(projectId))

  ipcMain.handle('vibe:chat:setGoNutzMode', async (_event, projectId: string, enabled: boolean) => {
    setGoNutzMode(projectId, enabled)
    await getSession(projectId)?.setGoNutzMode(enabled)
  })

  ipcMain.handle('vibe:chat:isGoNutzMode', (_event, projectId: string) => {
    return getSession(projectId)?.isGoNutzMode() ?? getProject(projectId)?.goNutzMode ?? false
  })

  ipcMain.handle('vibe:chat:loadTranscript', (_event, projectId: string) => loadTranscript(projectId))

  ipcMain.on(
    'vibe:chat:confirmationResponse',
    (_event, projectId: string, confirmationId: string, approved: boolean) => {
      getSession(projectId)?.resolveConfirmation(confirmationId, approved)
    }
  )

  ipcMain.handle('vibe:chat:pendingConfirmations', (_event, projectId: string) =>
    getSession(projectId)?.pendingConfirmations() ?? []
  )

  ipcMain.on('vibe:chat:dispose', (_event, projectId: string) => {
    disposeSession(projectId)
  })

  ipcMain.handle('vibe:git:hasChanges', (_event, projectPath: string) =>
    hasUncommittedChanges(projectPath)
  )

  ipcMain.handle('vibe:git:suggestMessage', (_event, projectPath: string) =>
    suggestCheckpointMessage(projectPath)
  )

  ipcMain.handle('vibe:git:checkpoint', (_event, projectPath: string, message: string) =>
    checkpoint(projectPath, message)
  )

  ipcMain.handle('vibe:git:history', (_event, projectPath: string) => history(projectPath))

  ipcMain.handle('vibe:git:restore', (_event, projectPath: string, commitHash: string) =>
    restoreCheckpoint(projectPath, commitHash)
  )

  function pathForScope(scope: MemoryScope, projectId: string): string {
    return scope === 'global' ? globalMemoryPath() : projectMemoryPath(projectId)
  }

  ipcMain.handle('vibe:memory:list', (_event, projectId: string, scope: MemoryScope) =>
    listFacts(pathForScope(scope, projectId))
  )

  ipcMain.handle(
    'vibe:memory:add',
    (_event, projectId: string, scope: MemoryScope, text: string) =>
      addFact(pathForScope(scope, projectId), text, 'user')
  )

  ipcMain.handle(
    'vibe:memory:update',
    (_event, projectId: string, scope: MemoryScope, id: string, text: string) =>
      updateFact(pathForScope(scope, projectId), id, text)
  )

  ipcMain.handle(
    'vibe:memory:delete',
    (_event, projectId: string, scope: MemoryScope, id: string) =>
      deleteFact(pathForScope(scope, projectId), id)
  )

  ipcMain.handle('vibe:settings:get', () => getSettings())

  ipcMain.handle('vibe:settings:update', async (_event, patch: Partial<AppSettings>) => {
    const before = getSettings()
    const next = updateSettings(patch)
    if ('claudeModel' in patch && next.claudeModel !== before.claudeModel) {
      await setModelForAllSessions(next.claudeModel)
    }
    return next
  })

  ipcMain.handle('vibe:models:claude', () => listClaudeModels())

  ipcMain.handle('vibe:themes:list', () => listThemes())
  ipcMain.handle('vibe:themes:delete', (_event, id: string) => deleteTheme(id))
  ipcMain.handle('vibe:themes:generate', (_event, description: string) => generateTheme(description))
  ipcMain.handle('vibe:themes:openFolder', () => shell.openPath(themesDir()))

  ipcMain.handle('vibe:usage:get', (_event, cli: CliName, force?: boolean) => getUsage(cli, force))

  previewEvents.on('state', (projectId: string, state: PreviewState) => {
    getSender()?.send('vibe:preview:state', projectId, state)
  })
  previewEvents.on('problem', (projectId: string, problem: PreviewProblem) => {
    getSender()?.send('vibe:preview:problem', projectId, problem)
  })
  ipcMain.handle('vibe:preview:start', (_event, projectId: string, projectPath: string) =>
    getPreview(projectId, projectPath).start()
  )
  ipcMain.handle('vibe:preview:stop', (_event, projectId: string) => findPreview(projectId)?.stop())
  ipcMain.handle(
    'vibe:preview:state',
    (_event, projectId: string): PreviewState => findPreview(projectId)?.getState() ?? { status: 'idle' }
  )
  ipcMain.handle('vibe:preview:log', (_event, projectId: string) => findPreview(projectId)?.getLog() ?? '')

  // Changing secrets restarts whatever uses them: Claude's session (after
  // its current turn) and a running preview.
  function secretsChanged(projectId: string): void {
    getSession(projectId)?.refreshSecrets()
    const preview = findPreview(projectId)
    const status = preview?.getState().status
    if (status === 'running' || status === 'starting') preview!.start().catch(() => undefined)
  }
  ipcMain.handle('vibe:secrets:list', (_event, projectId: string) => listSecrets(projectId))
  ipcMain.handle('vibe:secrets:set', (_event, projectId: string, name: string, value: string) => {
    const saved = setSecret(projectId, name, value)
    secretsChanged(projectId)
    return saved
  })
  ipcMain.handle('vibe:secrets:delete', (_event, projectId: string, name: string) => {
    deleteSecret(projectId, name)
    secretsChanged(projectId)
  })

  ipcMain.handle('vibe:publish:status', (_event, projectId: string, projectPath: string) =>
    publishStatus(projectId, projectPath)
  )
  ipcMain.handle(
    'vibe:publish:github',
    (_event, projectId: string, projectPath: string, options: { name: string; visibility: 'private' | 'public' }) =>
      publishToGitHub(projectId, projectPath, options)
  )
  ipcMain.handle('vibe:publish:ghInstall', () => wireInstallSession(startGhInstallSession()))
  ipcMain.handle('vibe:publish:ghLogin', () => wireInstallSession(startTerminalSession(ghLoginSessionOptions())))

  ipcMain.handle('vibe:publish:vercelLogin', async () => {
    const session = startTerminalSession(await vercelLoginSessionOptions())
    // Open the sign-in page for the user instead of making them copy the
    // link out of the terminal.
    let output = ''
    let opened = false
    session.on('data', (data: string) => {
      if (opened) return
      output += data
      const url = parseVercelLoginUrl(output)
      if (url) {
        opened = true
        shell.openExternal(url)
      }
    })
    return wireInstallSession(session)
  })

  const deployResults = new Map<string, string | null>()
  ipcMain.handle(
    'vibe:publish:vercel',
    async (_event, projectId: string, projectPath: string, includeSecrets: boolean) => {
      const session = startTerminalSession(await vercelDeploySessionOptions(projectId, projectPath, includeSecrets))
      let output = ''
      session.on('data', (data: string) => {
        output = (output + data).slice(-200_000)
      })
      session.once('exit', (exitCode: number) => {
        const url = exitCode === 0 ? parseVercelUrl(output) : null
        if (url) setDeployUrl(projectId, url)
        deployResults.set(session.id, url)
      })
      return wireInstallSession(session)
    }
  )
  ipcMain.handle('vibe:publish:vercelResult', (_event, sessionId: string) => {
    const url = deployResults.get(sessionId) ?? null
    deployResults.delete(sessionId)
    return url
  })
}

function describePicked(picked: PickedElement): string {
  const text = picked.text.trim().replace(/\s+/g, ' ').slice(0, 40)
  return `<${picked.tag}>${text ? ` "${text}"` : ''}`
}

function pickedNote(picked: PickedElement): string {
  return [
    '[VibeApp note: the user pointed at this element in the live preview. "This" / "it" in their message most likely means this element. Find where it comes from in the source and change it there.',
    `Page: ${picked.pageUrl}`,
    `CSS selector: ${picked.selector}`,
    `Visible text: ${picked.text.slice(0, 300) || '(none)'}`,
    `HTML: ${picked.html}]`
  ].join('\n')
}

const wiredSessions = new WeakSet<object>()

function wireSessionEvents(
  session: ReturnType<typeof getOrCreateSession>,
  projectId: string,
  getSender: () => WebContents | undefined
): void {
  if (wiredSessions.has(session)) return
  wiredSessions.add(session)

  session.on('event', (event: VibeEvent) => {
    handleSessionEvent(projectId, session, event, (forwarded) => {
      appendEvent(projectId, forwarded)
      getSender()?.send('vibe:chat:event', projectId, forwarded)
    })
  })
  session.on('confirmation_request', (request: ConfirmationRequest) => {
    getSender()?.send('vibe:chat:confirmationRequest', projectId, request)
  })
  session.on('session_id', (sdkSessionId: string) => {
    setSdkSessionId(projectId, sdkSessionId)
  })
}
