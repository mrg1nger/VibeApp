import { ipcMain, dialog, shell, type WebContents } from 'electron'
import { mkdirSync } from 'fs'
import type {
  AppSettings,
  CliName,
  ConfirmationRequest,
  ImageAttachment,
  MemoryCategory,
  MemoryScope,
  PickedElement,
  PreviewProblem,
  PreviewState,
  QuestionAnswers,
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
  setDeployUrl,
  removeProject
} from '../projects/store'
import { eraseProjectData } from '../projects/erase'
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
import {
  GLOBAL_SCOPE,
  listFacts,
  rememberFact,
  updateFact,
  forgetFact,
  restoreFact,
  deleteFact
} from '../memory/store'
import { memoryDb } from '../memory/paths'
import { tidyMemory, maybeTidy } from '../memory/tidy'
import { maybeRefreshCodeMap } from '../memory/codeMap'
import {
  ensureHistoryImported,
  prefetchBlock,
  recordAssistantMessage,
  recordUserMessage
} from '../memory/context'
import { runScribe, summarizeConversation, type TurnRecord } from '../memory/scribe'
import { syncAgentsFile } from '../memory/agentsFile'
import { usageSummary } from '../memory/store'
import { getSettings, updateSettings } from '../settings/store'
import { listClaudeModels } from '../cli/claudeModels'
import { listThemes, deleteTheme, themesDir } from '../themes/store'
import { generateTheme } from '../themes/generate'
import { claudeBlockedUntil, claudeHelpersAllowed, clearClaudeLimit, getUsage, noteClaudeLimit } from '../usage/usage'
import { takeSnapshot, restoreSnapshot } from '../git/snapshots'
import { routeMessage } from '../orchestrator/routing'
import { runTakeover, takeCatchUpNote } from '../orchestrator/takeover'
import { getPreview, findPreview, previewEvents } from '../preview/preview'
import { beginTurn, handleSessionEvent, skipReview } from '../review/reviewFlow'
import { prepareImages, imagesNote } from '../attachments/images'
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

  // Takes a project off the list; its folder is never touched. With erase,
  // VibeApp's own data for it (history, memory, secrets) is deleted too.
  ipcMain.handle('vibe:project:remove', (_event, projectId: string, erase: boolean) => {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('Invalid project id.')
    const removed = removeProject(projectId, !erase)
    if (!removed) return listProjects()
    if (erase) eraseProjectData(projectId)
    else {
      // Keep the data, but stop anything running for it.
      disposeSession(projectId)
      findPreview(projectId)?.stop(true)
    }
    return listProjects()
  })

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
    async (
      _event,
      projectId: string,
      projectPath: string,
      text: string,
      picked?: PickedElement,
      images?: ImageAttachment[]
    ) => {
      const project = getProject(projectId)
      const session = getOrCreateSession(
        projectId,
        projectPath,
        project?.sdkSessionId,
        project?.goNutzMode ?? false
      )
      wireSessionEvents(session, projectId, getSender)

      // Before anything else, so a bad file fails the send cleanly.
      const prepared = images?.length ? prepareImages(projectId, images) : []

      // Claude's plan is already used up: don't send it to Claude just to be
      // rejected; Codex takes the request (or the user is asked).
      const blockedUntil = claudeBlockedUntil()
      const takeoverMode = getSettings().limitTakeover
      if (blockedUntil !== null && takeoverMode !== 'off' && !process.env.VIBEAPP_SKIP_PREEMPTIVE) {
        const snapshot = await takeSnapshot(projectPath, text).catch(() => undefined)
        const thumbnails = prepared.map((p) => p.thumbnail)
        const element = picked ? pickedNote(picked) : undefined
        appendUserMessage(projectId, text, {
          snapshot,
          attachment: picked ? describePicked(picked) : undefined,
          images: thumbnails.length ? thumbnails : undefined
        })
        recordUserMessage(
          projectId,
          text,
          [picked ? describePicked(picked) : '', ...prepared.map((p) => `image: ${p.savedPath}`)]
            .filter(Boolean)
            .join('; ')
        )
        const request: LastRequest = { text, element, images: prepared.map((p) => p.savedPath), snapshot }
        lastRequests.set(projectId, request)
        if (takeoverMode === 'ask') {
          session.emit('event', { type: 'takeover_offer', text, resetsAt: blockedUntil } satisfies VibeEvent)
        } else {
          startTakeover(session, projectId, projectPath, request, blockedUntil)
        }
        return { snapshot, thumbnails }
      }

      // Snapshot first so "Undo" can put the files back exactly as they
      // were before this message (a failure only costs the undo button).
      // Haiku labels the request meanwhile, so the two waits overlap.
      const [snapshot, route] = await Promise.all([
        takeSnapshot(projectPath, text).catch((err: Error) => {
          console.warn('Snapshot failed:', err.message)
          return undefined
        }),
        routeMessage(text, getSettings(), { images: prepared.length, pointedAt: !!picked, projectId })
      ])

      // A very long conversation is re-read on every step. When enabled,
      // continue it in a fresh session seeded with a summary instead (the
      // key facts, history and code map are all in the database anyway).
      let carried: string | undefined
      if (getSettings().freshSessions && session.contextTokens() > rotateThreshold()) {
        try {
          ensureHistoryImported(projectId)
          const summary = await summarizeConversation(projectId)
          if (summary && session.rotate()) {
            carried = `[VibeApp note: this is a fresh session continuing earlier work, started to keep things fast. Summary of the conversation so far:\n${summary}\nThe history tool (mcp__vibe_memory__history) has the details.]`
          }
        } catch (err) {
          console.warn('Starting a fresh session failed; continuing in the current one:', (err as Error).message)
        }
      }

      try {
        await session.useModel(route.model)
      } catch (err) {
        console.warn('Model switch failed:', (err as Error).message)
      }

      // Quick edits skip the Codex review: it would take longer than the edit.
      beginTurn(projectId, { projectPath, request: text, snapshot, skipReview: route.skipReview })
      const thumbnails = prepared.map((p) => p.thumbnail)
      appendUserMessage(projectId, text, {
        snapshot,
        attachment: picked ? describePicked(picked) : undefined,
        images: thumbnails.length ? thumbnails : undefined
      })
      if (route.label) {
        session.emit('event', {
          type: 'route',
          label: route.label,
          reason: route.reason ?? '',
          detail: route.detail
        } satisfies VibeEvent)
      }
      // The user's own words, for Codex hand-offs and for searching later.
      const element = picked ? pickedNote(picked) : undefined
      session.setRequestContext({ text, element, images: prepared.map((p) => p.savedPath) })
      recordUserMessage(
        projectId,
        text,
        [picked ? describePicked(picked) : '', ...prepared.map((p) => `image: ${p.savedPath}`)]
          .filter(Boolean)
          .join('; ')
      )
      // Remembered facts and files that look related, found by a local
      // search (free), so Claude doesn't need a tool call to look them up.
      // Quick requests get it too: "which size are the slimes?" is quick,
      // and exactly where memory helps.
      const relevant = prefetchBlock(projectId, text)
      // First request in a project: start mapping the code now, in the background.
      maybeRefreshCodeMap(projectId, projectPath)
      turnRecords.set(projectId, { request: text, replies: [], actions: [], stopped: false, hadError: false })
      lastRequests.set(projectId, { text, element, images: prepared.map((p) => p.savedPath), snapshot })
      const message = [
        carried,
        // What Codex did on its own while Claude was out.
        takeCatchUpNote(projectId),
        route.note,
        relevant,
        picked ? pickedNote(picked) : undefined,
        prepared.length ? imagesNote(prepared) : undefined,
        text
      ]
        .filter(Boolean)
        .join('\n\n')
      session.send(
        message,
        prepared.map((p) => p.block)
      )
      return { snapshot, thumbnails }
    }
  )

  ipcMain.handle('vibe:chat:undo', (_event, projectPath: string, snapshot: string) =>
    restoreSnapshot(projectPath, snapshot)
  )

  ipcMain.on('vibe:chat:skipReview', (_event, projectId: string) => skipReview(projectId))

  // Stop: while Codex is reviewing, Claude is already done, so just skip the
  // review; otherwise interrupt Claude (and any Codex hand-off it's waiting on).
  ipcMain.handle('vibe:chat:stop', async (_event, projectId: string) => {
    const takeover = takeovers.get(projectId)
    if (takeover) {
      takeover.abort()
      return
    }
    if (skipReview(projectId)) return
    await getSession(projectId)?.stop()
  })

  // The user chose "Let Codex do it" after being offered a takeover.
  ipcMain.handle('vibe:chat:takeover', (_event, projectId: string, projectPath: string) => {
    const request = lastRequests.get(projectId)
    if (!request) return
    const project = getProject(projectId)
    const session = getOrCreateSession(projectId, projectPath, project?.sdkSessionId, project?.goNutzMode ?? false)
    wireSessionEvents(session, projectId, getSender)
    startTakeover(session, projectId, projectPath, request, claudeBlockedUntil())
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
    (_event, projectId: string, confirmationId: string, approved: boolean, answers?: QuestionAnswers) => {
      getSession(projectId)?.resolveConfirmation(confirmationId, approved, answers)
      if (answers) {
        // Keep the answers in the chat history, like anything else the user said.
        const text = Object.entries(answers)
          .map(([question, answer]) => `${question} → ${answer}`)
          .join('\n')
        appendUserMessage(projectId, text)
      }
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

  function scopeKey(scope: MemoryScope, projectId: string): string {
    return scope === 'global' ? GLOBAL_SCOPE : projectId
  }

  ipcMain.handle(
    'vibe:memory:list',
    (_event, projectId: string, scope: MemoryScope, includeForgotten?: boolean) =>
      listFacts(memoryDb(), scopeKey(scope, projectId), !!includeForgotten)
  )

  ipcMain.handle(
    'vibe:memory:add',
    (_event, projectId: string, scope: MemoryScope, text: string, category?: MemoryCategory, key?: boolean) =>
      rememberFact(memoryDb(), scopeKey(scope, projectId), text, 'user', { category, key }).fact
  )

  ipcMain.handle(
    'vibe:memory:update',
    (_event, id: string, patch: { text?: string; category?: MemoryCategory; key?: boolean }) =>
      updateFact(memoryDb(), id, patch)
  )

  ipcMain.handle('vibe:memory:forget', (_event, id: string) => forgetFact(memoryDb(), id, 'forgotten by you'))
  ipcMain.handle('vibe:memory:restore', (_event, id: string) => restoreFact(memoryDb(), id))
  ipcMain.handle('vibe:memory:delete', (_event, id: string) => deleteFact(memoryDb(), id))
  ipcMain.handle('vibe:memory:tidy', (_event, projectId: string, scope: MemoryScope) =>
    tidyMemory(scopeKey(scope, projectId))
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

  ipcMain.handle('vibe:usage:summary', (_event, days: number) =>
    usageSummary(memoryDb(), new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString())
  )

  ipcMain.handle('vibe:usage:get',(_event, cli: CliName, force?: boolean) => getUsage(cli, force))

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

/** Context size (tokens) past which a long conversation moves to a fresh session, if that's enabled. */
function rotateThreshold(): number {
  // The override is for testing; Claude Code's own prompt is ~40k of this.
  return Number(process.env.VIBEAPP_ROTATE_TOKENS) || 120_000
}

/** Per project: what's happened so far this request, kept for the memory scribe. */
const turnRecords = new Map<string, TurnRecord>()

/** The latest user request per project, so it can be handed to Codex if Claude turns out to be out. */
interface LastRequest {
  text: string
  element?: string
  images: string[]
  snapshot?: string
}
const lastRequests = new Map<string, LastRequest>()
/** Projects whose Claude turn just failed on the plan limit, waiting for that turn to end. */
const pendingTakeover = new Map<string, number | null>()
/** Running takeovers; aborting one stops Codex. */
const takeovers = new Map<string, AbortController>()

function startTakeover(
  session: ReturnType<typeof getOrCreateSession>,
  projectId: string,
  projectPath: string,
  request: LastRequest,
  resetsAt: number | null
): void {
  if (takeovers.has(projectId)) return
  const abort = new AbortController()
  takeovers.set(projectId, abort)
  // Codex builds it, so there's no second-opinion review to hold the result back.
  beginTurn(projectId, { projectPath, request: request.text, snapshot: request.snapshot, skipReview: true })
  runTakeover({
    projectId,
    projectPath,
    text: request.text,
    element: request.element,
    images: request.images,
    resetsAt,
    unsandboxed: session.isGoNutzMode(),
    emit: (event) => session.emit('event', event),
    signal: abort.signal
  })
    .catch((err: Error) => {
      session.emit('event', { type: 'error', message: err.message } satisfies VibeEvent)
      session.emit('event', { type: 'turn_complete' } satisfies VibeEvent)
    })
    .finally(() => takeovers.delete(projectId))
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
    if (event.type === 'claude_limit') {
      // Remember it so later requests go straight to Codex, and keep the
      // failed turn from being reviewed. What follows happens at its turn_complete.
      noteClaudeLimit(event.resetsAt)
      const last = lastRequests.get(projectId)
      const path = getProject(projectId)?.path
      if (last && path && !takeovers.has(projectId) && getSettings().limitTakeover !== 'off') {
        pendingTakeover.set(projectId, event.resetsAt)
        beginTurn(projectId, { projectPath: path, request: last.text, snapshot: last.snapshot, skipReview: true })
      }
    } else if (event.type === 'usage' && !takeovers.has(projectId)) {
      clearClaudeLimit() // a Claude request just ran fine
    }
    handleSessionEvent(projectId, session, event, (forwarded) => {
      appendEvent(projectId, forwarded)
      getSender()?.send('vibe:chat:event', projectId, forwarded)
      if (forwarded.type === 'assistant_text') recordAssistantMessage(projectId, forwarded.text)

      // What happened this request, for the scribe.
      const record = turnRecords.get(projectId)
      if (record) {
        if (forwarded.type === 'assistant_text') record.replies.push(forwarded.text)
        else if (forwarded.type === 'tool_call') record.actions.push(forwarded.friendlyLabel.slice(0, 160))
        else if (forwarded.type === 'error') record.hadError = true
        else if (forwarded.type === 'stopped') record.stopped = true
      }

      // Between requests is a good moment to save what was learned, tidy
      // memory and refresh the code map, if they need it.
      if (forwarded.type === 'turn_complete') {
        const path = getProject(projectId)?.path
        const finished = turnRecords.get(projectId)
        turnRecords.delete(projectId)
        if (finished && getSettings().autoMemory && claudeHelpersAllowed()) {
          runScribe(projectId, finished)
            .catch((err: Error) => console.warn('Saving memory failed:', err.message))
            .finally(() => {
              if (path) syncAgentsFile(projectId, path)
              maybeTidy(projectId)
              maybeTidy(GLOBAL_SCOPE)
            })
        } else {
          if (path) syncAgentsFile(projectId, path)
          maybeTidy(projectId)
          maybeTidy(GLOBAL_SCOPE)
        }
        if (path) maybeRefreshCodeMap(projectId, path)

        // The turn failed on Claude's plan limit: hand the request to Codex.
        if (pendingTakeover.has(projectId)) {
          const resetsAt = pendingTakeover.get(projectId) ?? null
          pendingTakeover.delete(projectId)
          const last = lastRequests.get(projectId)
          if (last && path) {
            if (getSettings().limitTakeover === 'ask') {
              session.emit('event', { type: 'takeover_offer', text: last.text, resetsAt } satisfies VibeEvent)
            } else {
              startTakeover(session, projectId, path, last, resetsAt)
            }
          }
        }
      }
    })
  })
  session.on('confirmation_request', (request: ConfirmationRequest) => {
    getSender()?.send('vibe:chat:confirmationRequest', projectId, request)
  })
  session.on('session_id', (sdkSessionId: string) => {
    setSdkSessionId(projectId, sdkSessionId)
  })
}
