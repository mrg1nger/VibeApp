import { ipcMain, dialog, type WebContents } from 'electron'
import { mkdirSync } from 'fs'
import type { CliName, ConfirmationRequest } from '@shared/types'
import { checkClaudeStatus } from '../cli/claude'
import { checkCodexStatus } from '../cli/codex'
import { startLoginSession, getLoginSession, disposeLoginSession } from '../pty/loginSession'
import {
  listProjects,
  recordProjectOpened,
  setSdkSessionId,
  getProject,
  setGoNutzMode
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
import { getOrCreateSession, getSession, disposeSession } from '../orchestrator/session'

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

  ipcMain.handle('vibe:chat:send', (_event, projectId: string, projectPath: string, text: string) => {
    const project = getProject(projectId)
    const session = getOrCreateSession(
      projectId,
      projectPath,
      project?.sdkSessionId,
      project?.goNutzMode ?? false
    )
    wireSessionEvents(session, projectId, getSender)
    appendUserMessage(projectId, text)
    session.send(text)
  })

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
}

const wiredSessions = new WeakSet<object>()

function wireSessionEvents(
  session: ReturnType<typeof getOrCreateSession>,
  projectId: string,
  getSender: () => WebContents | undefined
): void {
  if (wiredSessions.has(session)) return
  wiredSessions.add(session)

  session.on('event', (event) => {
    appendEvent(projectId, event)
    getSender()?.send('vibe:chat:event', projectId, event)
  })
  session.on('confirmation_request', (request: ConfirmationRequest) => {
    getSender()?.send('vibe:chat:confirmationRequest', projectId, request)
  })
  session.on('session_id', (sdkSessionId: string) => {
    setSdkSessionId(projectId, sdkSessionId)
  })
}
