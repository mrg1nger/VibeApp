import { app, dialog, shell, type WebContents } from 'electron'
import { addEventSink, invoke, ipc } from '../remote/bus'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { applyRemoteSettings } from '../remote/server'
import type {
  AppSettings,
  CliName,
  ConfirmationRequest,
  DeployEvent,
  DeployRecipe,
  ExtensionCheck,
  ExtensionDraft,
  ImageAttachment,
  MemoryCategory,
  MemoryScope,
  PickedElement,
  PreviewProblem,
  PreviewState,
  QuestionAnswers,
  Schedule,
  TalkAgent,
  VibeEvent
} from '@shared/types'
import { checkClaudeStatus } from '../cli/claude'
import { checkCodexStatus } from '../cli/codex'
import { findCli, isCliOnPath, refreshPathFromRegistry } from '../cli/execCli'
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
  setGitHubAutoBackup,
  removeProject
} from '../projects/store'
import {
  BehindError,
  backupFailed,
  cloneRepo,
  getLatest,
  githubAccount,
  githubUrl,
  listRepos,
  syncStatus,
  uploadToGitHub,
  useGitHubVersion
} from '../github/github'
import { eraseProjectData } from '../projects/erase'
import { appendUserMessage, appendEvent, loadRecentTranscript, loadTranscript } from '../projects/transcript'
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
  setModelForAllSessions,
  refreshExtensionsForAllSessions,
  type CompactResult
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
import { memoryDb, memoryDbPath, memoryServerScriptPath } from '../memory/paths'
import { tidyMemory, maybeTidy } from '../memory/tidy'
import { maybeRefreshCodeMap } from '../memory/codeMap'
import {
  ensureHistoryImported,
  prefetchBlock,
  recordAssistantMessage,
  recordUserMessage
} from '../memory/context'
import { runSavePass, runScribe, summarizeConversation, type TurnRecord } from '../memory/scribe'
import { getBrief, maybeRefreshBrief, refreshBrief } from '../memory/brief'
import { cleanCommand, isNotableCommand } from '../memory/commands'
import { syncAgentsFile } from '../memory/agentsFile'
import { agentUsageSince, codexUsageSince, keyFactsBlock, listRequests, logRequest, usageByProject, usageSummary } from '../memory/store'
import { RequestRecorder, type RequestStart } from '../usage/requestLog'
import { buildReport } from '../usage/report'
import {
  addTodo,
  clearDoneTodos,
  deleteTodo,
  getNotes,
  listTodos,
  reorderTodos,
  setNotes,
  todosSignature,
  updateTodo
} from '../memory/store'
import { getSettings, updateSettings } from '../settings/store'
import { checkForUpdate, installUpdate, updateState } from '../updates/updates'
import { workingProjects } from '../tray'
import { listClaudeModels } from '../cli/claudeModels'
import { listCodexModels } from '../cli/codexModels'
import { listThemes, deleteTheme, themesDir } from '../themes/store'
import { generateTheme } from '../themes/generate'
import { claudeBlockedUntil, clearClaudeLimit, getUsage, noteClaudeLimit } from '../usage/usage'
import { helpersAllowed } from '../helpers/helperJob'
import { checkCline, clineStatus } from '../cli/clineExec'
import { clineModelFor, listClineModels } from '../cli/clineAcp'
import { takeSnapshot, restoreSnapshot } from '../git/snapshots'
import { routeMessage } from '../orchestrator/routing'
import { approvedPlanNote, codexPlanBuildNote, looksBig, matchTodosToSteps, parsePlanSteps, PLAN_INSTRUCTIONS, progressMarkers } from '@shared/plan'
import { briefBlock } from '../memory/brief'
import { codexFailure, runCodexExec } from '../cli/codexExec'
import { countsFromCodexEvents } from '../usage/tokens'
import { askNoteText, isPlainQuestion, isTodoListRequest } from '../orchestrator/questions'
import { askClaude, askCodex, ClaudeLimitError } from '../chat/ask'
import { runTalk, stopTalk, getTalk } from '../chat/talk'
import { deleteTalk, listTalks } from '../chat/talkStore'
import { recordUsage } from '../usage/tokens'
import { CATALOG } from '../extensions/catalog'
import {
  addExtension,
  extensionLaunch,
  listExtensions,
  removeExtension,
  setExtensionEnabled,
  setExtensionEnv
} from '../extensions/store'
import { selfTestServer, type SelfTestProbe } from '../extensions/selftest'
import { deployEvents, getRecipe, isDeploying, removeRecipe, runDeploy, saveRecipe, stopDeploy, type DeployResult } from '../deploy/deploy'
import { backupDir, backupNow, defaultBackupDir, listBackups, stageRestore } from '../backup/backup'
import { DEFAULT_NTFY_SERVER, newTopic, sendPhoneAlert, topicUrl } from '../notify/phone'
import { notifyUser } from '../tray'
import {
  listSchedules,
  removeSchedule,
  runScheduleNow,
  saveSchedule,
  scheduleEvents,
  setScheduleEnabled,
  startScheduler,
  summarize as summarizeSchedule,
  watchChatEvent,
  watchDeployEvent
} from '../schedule/scheduler'
import type { ScheduleInput } from '@shared/schedule'
import { runTakeover, takeCatchUpNote } from '../orchestrator/takeover'
import { getPreview, findPreview, previewEvents } from '../preview/preview'
import { beginTurn, handleSessionEvent, skipReview } from '../review/reviewFlow'
import { isPlanFile } from '../orchestrator/planGuard'
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
  ipc.handle('vibe:ping', () => 'pong')

  ipc.handle('vibe:auth:check', async (_event, cli: CliName) => {
    return cli === 'claude' ? checkClaudeStatus() : checkCodexStatus()
  })

  ipc.handle('vibe:auth:login', async (_event, cli: CliName) => {
    const session = startLoginSession(cli)

    session.on('data', (data: string) => {
      getSender()?.send('vibe:login:data', session.id, data)
    })
    session.on('exit', (exitCode: number) => {
      getSender()?.send('vibe:login:exit', session.id, exitCode)
    })

    return session.id
  })

  ipc.on('vibe:login:write', (_event, sessionId: string, data: string) => {
    getLoginSession(sessionId)?.write(data)
  })

  ipc.on('vibe:login:resize', (_event, sessionId: string, cols: number, rows: number) => {
    getLoginSession(sessionId)?.resize(cols, rows)
  })

  ipc.on('vibe:login:dispose', (_event, sessionId: string) => {
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

  ipc.handle('vibe:auth:checkNode', () => isCliOnPath('node'))
  ipc.handle('vibe:auth:checkGit', () => isCliOnPath('git'))

  ipc.handle('vibe:auth:installNode', () => wireInstallSession(startNodeInstallSession()))
  ipc.handle('vibe:auth:installGit', () => wireInstallSession(startGitInstallSession()))

  ipc.handle('vibe:auth:install', (_event, cli: CliName) =>
    wireInstallSession(startInstallSession(cli))
  )

  ipc.on('vibe:install:write', (_event, sessionId: string, data: string) => {
    getInstallSession(sessionId)?.write(data)
  })

  ipc.on('vibe:install:resize', (_event, sessionId: string, cols: number, rows: number) => {
    getInstallSession(sessionId)?.resize(cols, rows)
  })

  ipc.on('vibe:install:dispose', (_event, sessionId: string) => {
    disposeInstallSession(sessionId)
  })

  ipc.handle('vibe:project:list', () => listProjects())

  // Takes a project off the list; its folder is never touched. With erase,
  // VibeApp's own data for it (history, memory, secrets) is deleted too.
  ipc.handle('vibe:project:remove', (_event, projectId: string, erase: boolean) => {
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

  ipc.handle('vibe:project:pickExisting', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const projectPath = result.filePaths[0]
    await ensureRepo(projectPath)
    return recordProjectOpened(projectPath)
  })

  // In a browser there are no folder dialogs: the screens browse folders on this computer instead.
  ipc.handle('vibe:fs:listDirs', (_event, dir?: string) => listDirs(dir))
  ipc.handle('vibe:project:openFolder', async (_event, folder: string) => {
    if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) throw new Error("That folder doesn't exist.")
    await ensureRepo(folder)
    return recordProjectOpened(folder)
  })
  ipc.handle('vibe:project:createFolder', async (_event, parent: string, name: string) => {
    const clean = String(name ?? '').trim()
    if (!clean || /[<>:"/\\|?*]/.test(clean)) throw new Error('Use a folder name without < > : " / \\ | ? *')
    if (!parent || !existsSync(parent)) throw new Error("The place to create it in doesn't exist.")
    const folder = join(parent, clean)
    mkdirSync(folder, { recursive: true })
    await ensureRepo(folder)
    return recordProjectOpened(folder)
  })

  ipc.handle('vibe:project:pickNewFolder', async () => {
    const result = await dialog.showSaveDialog({ properties: ['createDirectory'] })
    if (result.canceled || !result.filePath) return null
    mkdirSync(result.filePath, { recursive: true })
    await ensureRepo(result.filePath)
    return recordProjectOpened(result.filePath)
  })

  ipc.handle(
    'vibe:chat:send',
    async (
      _event,
      projectId: string,
      projectPath: string,
      text: string,
      picked?: PickedElement,
      images?: ImageAttachment[],
      forceBuild?: boolean,
      /** Plan mode (propose a plan, change nothing), or building a plan the user approved. */
      extra?: { mode?: 'build' | 'plan'; approvedPlan?: string; todoId?: string }
    ) => {
      let planning = extra?.mode === 'plan'
      // "Build this" on a to-do: tick it off when this request finishes (a plan's, once it's built).
      if (extra?.todoId && !planning) turnTodos.set(projectId, { id: String(extra.todoId) })
      else turnTodos.delete(projectId)
      // A plain question doesn't need the full coding session (and its whole
      // conversation re-read on every step): answer it the cheap way.
      if (
        !forceBuild &&
        !planning &&
        !extra?.approvedPlan &&
        !picked &&
        !images?.length &&
        getSettings().autoAsk &&
        !asks.has(projectId) &&
        (isPlainQuestion(text) || isTodoListRequest(text))
      ) {
        runAsk(projectId, projectPath, text, getSender, true)
        return { snapshot: undefined, thumbnails: [] as string[] }
      }

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
      if (planning && blockedUntil !== null) {
        // Claude is out: Codex makes the plan instead, read-only. Nothing is built until it's approved.
        appendUserMessage(projectId, text)
        recordUserMessage(projectId, text, 'plan (by Codex)')
        // A question answered just before goes along, as it does for Claude.
        void runCodexPlan(session, projectId, projectPath, [takeAskNote(projectId), text].filter(Boolean).join('\n\n'))
        return { snapshot: undefined, thumbnails: [] as string[] }
      }
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
        const request: LastRequest = {
          text: [takeAskNote(projectId), extra?.approvedPlan ? codexPlanBuildNote(extra.approvedPlan) : text].filter(Boolean).join('\n\n'),
          element,
          images: prepared.map((p) => p.savedPath),
          snapshot
        }
        lastRequests.set(projectId, request)
        if (extra?.approvedPlan) {
          rememberApprovedPlan(projectId, extra.approvedPlan)
          startPlanBuild(projectId, extra.approvedPlan)
        }
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
        // "OK, fix it" after a question is judged together with that question.
        routeMessage(
          // Building an approved plan is judged by the plan, not by the "go ahead" line.
          [peekAskQuestions(projectId), extra?.approvedPlan ? `Build this approved plan:\n${extra.approvedPlan.slice(0, 4000)}` : text]
            .filter(Boolean)
            .join('\n'),
          getSettings(),
          { images: prepared.length, pointedAt: !!picked, projectId, notQuick: planning || !!extra?.approvedPlan }
        )
      ])

      // A big request sent in Build: offer to plan it first (or just plan it, if that's the setting).
      const bigAsk = getSettings().planBigRequests
      if (!planning && !extra && !forceBuild && bigAsk !== 'off' && (route.size === 'complex' || looksBig(text))) {
        if (bigAsk === 'always') {
          planning = true
        } else {
          session.emit('event', { type: 'plan_suggested', text } satisfies VibeEvent)
          return { snapshot: undefined, thumbnails: [] as string[] }
        }
      }

      // A very long conversation is re-read on every step. When enabled,
      // continue it in a fresh session seeded with a summary instead (the
      // key facts, history and code map are all in the database anyway).
      // A fresh session the user started by hand brings its summary along now.
      let carried: string | undefined = pendingCarry.get(projectId)
      pendingCarry.delete(projectId)
      if (!carried && session.contextTokens() > rotateThreshold()) {
        try {
          if (getSettings().autoCompact) await compactWithSafeguards(session, projectId)
          else if (getSettings().freshSessions) carried = await rotateWithSummary(session, projectId)
        } catch (err) {
          console.warn('Shrinking the conversation failed; continuing as it is:', (err as Error).message)
        }
      }

      // The prompt cache is per model, so dropping to Haiku in a big
      // conversation re-processes all of it, costing more than a quick edit
      // saves. Stay on the current model then.
      if (
        route.model === 'haiku' &&
        (session.contextTokens() > CACHE_KEEP_TOKENS || session.contextSizeUnknown())
      ) {
        route.model = null
        route.label = undefined
        route.reason = undefined
        route.detail = undefined
      } else {
        try {
          await session.useModel(route.model)
        } catch (err) {
          console.warn('Model switch failed:', (err as Error).message)
        }
      }

      // Quick edits skip the Codex review: it would take longer than the edit.
      // Planning changes nothing, so there's nothing to review.
      beginTurn(projectId, { projectPath, request: text, snapshot, skipReview: route.skipReview || planning })
      startRequestLog({
        projectId,
        mode: planning ? 'plan' : extra?.approvedPlan ? 'plan_build' : 'build',
        text,
        balance: getSettings().agentBalance ?? 'auto',
        route: route.label ? `${route.label}${route.reason ? ` · ${route.reason}` : ''}${route.detail ? ` [${route.detail}]` : ''}` : null,
        size: route.size
      })
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
      turnRecords.set(projectId, { request: text, replies: [], actions: [], commands: [], stopped: false, hadError: false })
      lastRequests.set(projectId, { text, element, images: prepared.map((p) => p.savedPath), snapshot })
      const message = [
        carried,
        // What Codex did on its own while Claude was out.
        takeCatchUpNote(projectId),
        takeUndoNote(projectId),
        takeAskNote(projectId),
        route.note,
        planning
          ? "[VibeApp note: Plan mode. Explore and propose a plan for the user to approve; change nothing yet. If this message needs something done now rather than planned, call mcp__vibe_tools__leave_plan_mode first (it asks the user).]"
          : undefined,
        extra?.approvedPlan ? approvedPlanNote(extra.approvedPlan) : undefined,
        relevant,
        picked ? pickedNote(picked) : undefined,
        prepared.length ? imagesNote(prepared) : undefined,
        text
      ]
        .filter(Boolean)
        .join('\n\n')
      try {
        await session.setPlanning(planning)
      } catch (err) {
        console.warn('Switching plan mode failed:', (err as Error).message)
      }
      if (extra?.approvedPlan) {
        rememberApprovedPlan(projectId, extra.approvedPlan)
        startPlanBuild(projectId, extra.approvedPlan)
      }
      session.send(
        message,
        prepared.map((p) => p.block)
      )
      return { snapshot, thumbnails }
    }
  )

  ipc.handle(
    'vibe:chat:undo',
    async (_event, projectPath: string, snapshot: string, projectId?: string, kind?: 'undo' | 'redo', request?: string) => {
      const result = await restoreSnapshot(projectPath, snapshot)
      // Memory and Claude would otherwise still believe the undone work exists.
      if (projectId && result.changedFiles.length) {
        const files = result.changedFiles.slice(0, 15).join(', ')
        const what =
          kind === 'redo'
            ? `The user pressed Redo: the changes to ${files} are back.`
            : `The user pressed Undo: ${files} ${result.changedFiles.length === 1 ? 'is' : 'are'} back to how ${result.changedFiles.length === 1 ? 'it was' : 'they were'} before the request${request ? ` "${request.slice(0, 120)}"` : ''}, so the work done in it (and anything after) is gone.`
        recordUserMessage(projectId, `[${what}]`, kind ?? 'undo')
        undoNotes.set(projectId, [...(undoNotes.get(projectId) ?? []), what])
      }
      return result
    }
  )

  ipc.on('vibe:chat:skipReview', (_event, projectId: string) => skipReview(projectId))

  // Stop: while Codex is reviewing, Claude is already done, so just skip the
  // review; otherwise interrupt Claude (and any Codex hand-off it's waiting on).
  // The user approved, asked to change, or cancelled a proposed plan: keep that in the chat (for
  // every screen, and for when it's reopened), and leave plan mode when it's cancelled.
  ipc.handle('vibe:chat:planDecided', async (_event, projectId: string, toolUseId: string, decision: 'approved' | 'revised' | 'cancelled') => {
    const event: VibeEvent = { type: 'plan_decided', toolUseId, decision }
    appendEvent(projectId, event)
    getSender()?.send('vibe:chat:event', projectId, event)
    if (decision === 'cancelled') {
      await getSession(projectId)?.setPlanning(false)
      clearPlanFile(projectId)
    }
  })

  // The user chose "Compact now".
  ipc.handle('vibe:chat:compactNow', async (_event, projectId: string, projectPath: string) => {
    if (asks.has(projectId) || takeovers.has(projectId)) {
      return { ok: false, message: 'Wait for the current request to finish first.' }
    }
    const project = getProject(projectId)
    const session = getOrCreateSession(projectId, projectPath, project?.sdkSessionId, project?.goNutzMode ?? false)
    wireSessionEvents(session, projectId, getSender)
    try {
      const result = await compactWithSafeguards(session, projectId)
      if (!result) {
        return { ok: false, message: "The conversation couldn't be compacted right now (a request may still be running)." }
      }
      return { ok: true, before: result.before, after: result.after }
    } catch (err) {
      return { ok: false, message: `Couldn't compact the conversation: ${(err as Error).message}` }
    }
  })

  // The user chose "Start a fresh session now".
  ipc.handle('vibe:chat:rotateNow', async (_event, projectId: string, projectPath: string) => {
    if (asks.has(projectId) || takeovers.has(projectId)) {
      return { ok: false, message: 'Wait for the current request to finish first.' }
    }
    const project = getProject(projectId)
    const session = getOrCreateSession(projectId, projectPath, project?.sdkSessionId, project?.goNutzMode ?? false)
    wireSessionEvents(session, projectId, getSender)
    try {
      const carried = await rotateWithSummary(session, projectId)
      if (!carried) {
        return {
          ok: false,
          message:
            "A fresh session couldn't be started right now (a request may still be running, or there's no conversation to summarise yet)."
        }
      }
      pendingCarry.set(projectId, carried)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: `Couldn't start a fresh session: ${(err as Error).message}` }
    }
  })

  ipc.handle('vibe:chat:contextSize', (_event, projectId: string) => getSession(projectId)?.contextTokens() ?? 0)

  ipc.handle('vibe:chat:stop', async (_event, projectId: string) => {
    const ask = asks.get(projectId)
    if (ask) {
      ask.abort()
      return
    }
    const takeover = takeovers.get(projectId)
    if (takeover) {
      takeover.abort()
      return
    }
    if (skipReview(projectId)) return
    await getSession(projectId)?.stop()
  })

  // Ask mode: answer a question about the project without changing anything.
  ipc.handle('vibe:chat:ask', (_event, projectId: string, projectPath: string, text: string) => {
    runAsk(projectId, projectPath, text, getSender, false)
  })

  ipc.handle('vibe:memory:brief', (_event, projectId: string) => getBrief(projectId) ?? null)
  ipc.handle('vibe:memory:refreshBrief', async (_event, projectId: string, projectPath: string) => {
    const brief = await refreshBrief(projectId, projectPath, { force: true })
    return brief ?? getBrief(projectId) ?? null
  })

  ipc.handle('vibe:talk:list', () => listTalks())
  ipc.handle('vibe:talk:load', (_event, id: string) => getTalk(id) ?? null)
  ipc.handle('vibe:talk:send', (_event, id: string, text: string, agent: TalkAgent) => runTalk(id, text, agent))
  ipc.handle('vibe:talk:stop', (_event, id: string) => stopTalk(id))
  ipc.handle('vibe:talk:delete', (_event, id: string) => deleteTalk(id))

  // The user chose "Let Codex do it" after being offered a takeover.
  ipc.handle('vibe:chat:takeover', (_event, projectId: string, projectPath: string) => {
    const request = lastRequests.get(projectId)
    if (!request) return
    const project = getProject(projectId)
    const session = getOrCreateSession(projectId, projectPath, project?.sdkSessionId, project?.goNutzMode ?? false)
    wireSessionEvents(session, projectId, getSender)
    startTakeover(session, projectId, projectPath, request, claudeBlockedUntil())
  })

  ipc.handle('vibe:chat:setGoNutzMode', async (_event, projectId: string, enabled: boolean) => {
    setGoNutzMode(projectId, enabled)
    await getSession(projectId)?.setGoNutzMode(enabled)
  })

  ipc.handle('vibe:chat:isGoNutzMode', (_event, projectId: string) => {
    return getSession(projectId)?.isGoNutzMode() ?? getProject(projectId)?.goNutzMode ?? false
  })

  ipc.handle('vibe:chat:loadTranscript', (_event, projectId: string) => loadTranscript(projectId))
  // The recent part only: what the chat shows when it opens (0 = everything).
  ipc.handle('vibe:chat:loadRecent', (_event, projectId: string, requests: number) =>
    loadRecentTranscript(projectId, Number(requests) || 0)
  )

  ipc.on(
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

  ipc.handle('vibe:chat:pendingConfirmations', (_event, projectId: string) =>
    getSession(projectId)?.pendingConfirmations() ?? []
  )

  ipc.on('vibe:chat:dispose', (_event, projectId: string) => {
    disposeSession(projectId)
  })

  ipc.handle('vibe:git:hasChanges', (_event, projectPath: string) =>
    hasUncommittedChanges(projectPath)
  )

  ipc.handle('vibe:git:suggestMessage', (_event, projectPath: string) =>
    suggestCheckpointMessage(projectPath)
  )

  ipc.handle('vibe:git:checkpoint', (_event, projectPath: string, message: string) =>
    checkpoint(projectPath, message)
  )

  ipc.handle('vibe:git:history', (_event, projectPath: string) => history(projectPath))

  ipc.handle('vibe:git:restore', (_event, projectPath: string, commitHash: string) =>
    restoreCheckpoint(projectPath, commitHash)
  )

  function scopeKey(scope: MemoryScope, projectId: string): string {
    return scope === 'global' ? GLOBAL_SCOPE : projectId
  }

  ipc.handle(
    'vibe:memory:list',
    (_event, projectId: string, scope: MemoryScope, includeForgotten?: boolean) =>
      listFacts(memoryDb(), scopeKey(scope, projectId), !!includeForgotten)
  )

  ipc.handle(
    'vibe:memory:add',
    (_event, projectId: string, scope: MemoryScope, text: string, category?: MemoryCategory, key?: boolean) =>
      rememberFact(memoryDb(), scopeKey(scope, projectId), text, 'user', { category, key }).fact
  )

  ipc.handle(
    'vibe:memory:update',
    (_event, id: string, patch: { text?: string; category?: MemoryCategory; key?: boolean }) =>
      updateFact(memoryDb(), id, patch)
  )

  ipc.handle('vibe:memory:forget', (_event, id: string) => forgetFact(memoryDb(), id, 'forgotten by you'))
  ipc.handle('vibe:memory:restore', (_event, id: string) => restoreFact(memoryDb(), id))
  ipc.handle('vibe:memory:delete', (_event, id: string) => deleteFact(memoryDb(), id))
  ipc.handle('vibe:memory:tidy', (_event, projectId: string, scope: MemoryScope) =>
    tidyMemory(scopeKey(scope, projectId))
  )

  ipc.handle('vibe:extensions:list', async () => ({
    installed: listExtensions(),
    catalog: CATALOG,
    nodeAvailable: (await findCli('npx')) !== 'missing'
  }))
  ipc.handle('vibe:extensions:add', (_event, draft: ExtensionDraft) => {
    const added = addExtension(draft)
    refreshExtensionsForAllSessions()
    return added
  })
  ipc.handle('vibe:extensions:setEnabled', (_event, id: string, enabled: boolean) => {
    setExtensionEnabled(id, enabled)
    refreshExtensionsForAllSessions()
  })
  ipc.handle('vibe:extensions:setEnv', (_event, id: string, env: Record<string, string>) => {
    setExtensionEnv(id, env)
    refreshExtensionsForAllSessions()
  })
  // The project's to-do list and notes (its Notes tab).
  sendTodosChanged = (projectId) => getSender()?.send('vibe:todos:changed', projectId)
  watchTodos()
  ipc.handle('vibe:todos:list', (_event, projectId: string) => listTodos(memoryDb(), projectId))
  ipc.handle('vibe:todos:add', (_event, projectId: string, text: string, top?: boolean) => {
    addTodo(memoryDb(), projectId, text, 'user', { top: !!top })
    todosChanged(projectId)
    return listTodos(memoryDb(), projectId)
  })
  ipc.handle('vibe:todos:update', (_event, projectId: string, id: string, patch: { text?: string; done?: boolean }) => {
    updateTodo(memoryDb(), projectId, id, { text: patch?.text, done: patch?.done })
    todosChanged(projectId)
    return listTodos(memoryDb(), projectId)
  })
  ipc.handle('vibe:todos:remove', (_event, projectId: string, id: string) => {
    deleteTodo(memoryDb(), projectId, id)
    todosChanged(projectId)
    return listTodos(memoryDb(), projectId)
  })
  ipc.handle('vibe:todos:clearDone', (_event, projectId: string) => {
    clearDoneTodos(memoryDb(), projectId)
    todosChanged(projectId)
    return listTodos(memoryDb(), projectId)
  })
  ipc.handle('vibe:todos:reorder', (_event, projectId: string, ids: string[]) => {
    reorderTodos(memoryDb(), projectId, Array.isArray(ids) ? ids.map(String) : [])
    todosChanged(projectId)
    return listTodos(memoryDb(), projectId)
  })
  ipc.handle('vibe:notes:get', (_event, projectId: string) => getNotes(memoryDb(), projectId))
  ipc.handle('vibe:notes:set', (_event, projectId: string, text: string) => {
    const updatedAt = setNotes(memoryDb(), projectId, String(text ?? ''))
    getSender()?.send('vibe:notes:changed', projectId, updatedAt)
    return { updatedAt }
  })

  // One-click Deploy: the project's recipe, run by VibeApp with no AI.
  deployEvents.on('event', (projectId: string, event: DeployEvent) => getSender()?.send('vibe:deploy:event', projectId, event))
  deployEvents.on('changed', (projectId: string) => getSender()?.send('vibe:deploy:changed', projectId))
  deployEvents.on('recipe-ready', (projectId: string, recipe: DeployRecipe) => {
    const event: VibeEvent = { type: 'deploy_recipe_ready', name: recipe.name, steps: recipe.steps.length }
    appendEvent(projectId, event)
    getSender()?.send('vibe:chat:event', projectId, event)
  })
  ipc.handle('vibe:deploy:get', (_event, projectId: string) => ({ recipe: getRecipe(projectId), running: isDeploying(projectId) }))
  ipc.handle('vibe:deploy:save', (_event, projectId: string, recipe: Partial<DeployRecipe>) => saveRecipe(projectId, recipe, 'user', true))
  ipc.handle('vibe:deploy:remove', (_event, projectId: string) => removeRecipe(projectId))
  ipc.handle('vibe:deploy:stop', (_event, projectId: string) => stopDeploy(projectId))
  ipc.handle('vibe:deploy:run', (_event, projectId: string, projectPath: string) => {
    // Refused straight away (the window and schedules show why), rather than only in the chat.
    if (!getRecipe(projectId)?.confirmed) throw new Error('Check the deploy recipe and save it before running it.')
    if (isDeploying(projectId)) throw new Error('A deploy is already running for this project.')
    void deployNow(projectId, projectPath, 'user', getSender).catch(() => undefined)
    return { started: true }
  })

  // Schedules: requests, the next to-do, Deploy or a site check at set times (or after each Deploy).
  const scheduleChat = (projectId: string, event: VibeEvent): void => {
    appendEvent(projectId, event)
    getSender()?.send('vibe:chat:event', projectId, event)
  }
  deployEvents.on('event', (projectId: string, event: DeployEvent) => watchDeployEvent(projectId, event))
  addEventSink((channel, args) => {
    if (channel !== 'vibe:chat:event') return
    watchChatEvent(args[0] as string, args[1] as VibeEvent)
    observeRequestLog(args[0] as string, args[1] as VibeEvent)
    if ((args[1] as VibeEvent).type === 'turn_complete') autoBackup(args[0] as string)
  })
  const projectBusy = (projectId: string): boolean =>
    !!getSession(projectId)?.isBusy() || asks.has(projectId) || takeovers.has(projectId) || isDeploying(projectId)
  scheduleEvents.on('changed', (projectId: string) => getSender()?.send('vibe:schedules:changed', projectId))
  scheduleEvents.on('ready', (projectId: string, s: Schedule) =>
    scheduleChat(projectId, { type: 'schedule_ready', scheduleId: s.id, name: s.name, summary: summarizeSchedule(s) })
  )
  startScheduler({
    projectPath: (projectId) => getProject(projectId)?.path,
    busy: projectBusy,
    startRequest: async (projectId, projectPath, text, mode, todoId) => {
      if (mode === 'ask') await invoke('vibe:chat:ask', [projectId, projectPath, text])
      // As Build (or Plan) for sure: no "plan it first?" or quick-question detour with nobody there to answer.
      else await invoke('vibe:chat:send', [projectId, projectPath, text, undefined, undefined, true, { mode, ...(todoId ? { todoId } : {}) }])
    },
    startDeploy: async (projectId, projectPath) => {
      await invoke('vibe:deploy:run', [projectId, projectPath])
    },
    backup: (projectId, projectPath) => backupToGitHub(projectId, projectPath),
    chatEvent: scheduleChat,
    notify: notifyUser,
    projectName,
    topTodo: (projectId) => listTodos(memoryDb(), projectId).find((t) => !t.done),
    claudeUsage: async () => {
      const usage = await getUsage('claude')
      return usage.windows.length ? Math.max(...usage.windows.map((w) => w.usedPercent)) : undefined
    }
  })
  const withNames = (list: Schedule[]): (Schedule & { projectName: string })[] => list.map((s) => ({ ...s, projectName: projectName(s.projectId) }))
  ipc.handle('vibe:schedules:list', (_event, projectId: string) => listSchedules(String(projectId)))
  ipc.handle('vibe:schedules:all', () => withNames(listSchedules()))
  ipc.handle('vibe:schedules:save', (_event, projectId: string, input: ScheduleInput & { id?: string }) => {
    if (!getProject(projectId)) throw new Error("That project isn't in VibeApp.")
    return saveSchedule(projectId, input ?? {}, 'user', true)
  })
  ipc.handle('vibe:schedules:setEnabled', (_event, id: string, enabled: boolean) => setScheduleEnabled(String(id), !!enabled))
  ipc.handle('vibe:schedules:remove', (_event, id: string) => removeSchedule(String(id)))
  ipc.handle('vibe:schedules:runNow', (_event, id: string) => runScheduleNow(String(id)))

  // GitHub: the project's copy there (backups, newer work from another computer, downloading one).
  const githubChanged = (projectId: string): void => getSender()?.send('vibe:github:changed', projectId)
  const githubNote = (projectId: string, text: string): void => {
    const event: VibeEvent = { type: 'github_note', text }
    appendEvent(projectId, event)
    getSender()?.send('vibe:chat:event', projectId, event)
  }
  async function backupToGitHub(projectId: string, projectPath: string): Promise<string> {
    if (!(await githubUrl(projectPath))) throw new Error('This project has no GitHub copy yet: make one in Publish.')
    const message = `Backup: ${await suggestCheckpointMessage(projectPath).catch(() => 'latest work')}`
    try {
      const pushed = await uploadToGitHub(projectId, projectPath, message)
      return pushed ? 'Uploaded to GitHub.' : 'Nothing new to upload.'
    } catch (err) {
      backupFailed(projectId, (err as Error).message)
      throw err
    } finally {
      githubChanged(projectId)
    }
  }
  // After each finished request (when switched on): a line in the chat and a
  // phone alert only when a backup can't go, once per problem, and when it works again.
  const autoProblems = new Map<string, string>()
  const autoTimers = new Map<string, NodeJS.Timeout>()
  function autoBackup(projectId: string): void {
    if (!getProject(projectId)?.githubAutoBackup) return
    clearTimeout(autoTimers.get(projectId))
    autoTimers.set(
      projectId,
      setTimeout(async () => {
        autoTimers.delete(projectId)
        const project = getProject(projectId)
        // Busy again (a queued message): the next finished request backs it all up.
        if (!project?.githubAutoBackup || projectBusy(projectId) || !(await githubUrl(project.path).catch(() => null))) return
        try {
          await backupToGitHub(projectId, project.path)
          if (autoProblems.delete(projectId)) githubNote(projectId, '💾 Backing up to GitHub works again: everything is uploaded.')
        } catch (err) {
          const problem = (err as Error).message
          if (autoProblems.get(projectId) === problem) return
          autoProblems.set(projectId, problem)
          const behind = err instanceof BehindError
          githubNote(
            projectId,
            behind
              ? "💾 Not backed up: GitHub has newer work for this project from your other computer. Press 'Get it' at the top of the chat, and backups carry on."
              : `💾 Couldn't back up to GitHub: ${problem}`
          )
          notifyUser(`${projectName(projectId)}: GitHub backup didn't go`, behind ? 'GitHub has newer work from your other computer: get it first.' : problem)
        }
      }, Number(process.env.VIBEAPP_GITHUB_BACKUP_DELAY_MS) || 4000)
    )
  }
  ipc.handle('vibe:github:status', (_event, projectId: string, projectPath: string, fetch?: boolean) =>
    syncStatus(String(projectId), String(projectPath), fetch !== false)
  )
  ipc.handle('vibe:github:backup', async (_event, projectId: string, projectPath: string) => {
    const result = await backupToGitHub(String(projectId), String(projectPath))
    autoProblems.delete(projectId)
    return result
  })
  ipc.handle('vibe:github:setAutoBackup', async (_event, projectId: string, enabled: boolean) => {
    setGitHubAutoBackup(String(projectId), !!enabled)
    githubChanged(projectId)
    const project = getProject(projectId)
    return project ? syncStatus(project.id, project.path, false) : null
  })
  ipc.handle('vibe:github:getLatest', async (_event, projectId: string, projectPath: string) => {
    if (projectBusy(projectId)) throw new Error('Wait until the current request has finished, then get it.')
    const before = await syncStatus(projectId, projectPath, false)
    const result = await getLatest(projectId, projectPath)
    if (result.status === 'updated') {
      const list = (before.incoming ?? []).slice(0, 5).map((m) => `"${m}"`).join(', ')
      githubNote(projectId, `⬇ Brought in ${result.count} newer checkpoint${result.count === 1 ? '' : 's'} from GitHub${result.merged ? ", combined with this computer's work" : ''}.`)
      // Claude hears about it with the next message, like an Undo.
      const notes = undoNotes.get(projectId) ?? []
      notes.push(`The project was updated with newer work from GitHub (made on the user's other computer${list ? `: ${list}` : ''}), so files may have changed since you last saw them.`)
      undoNotes.set(projectId, notes)
      autoProblems.delete(projectId)
      autoBackup(projectId)
    }
    githubChanged(projectId)
    return result
  })
  ipc.handle('vibe:github:useGitHubVersion', async (_event, projectId: string, projectPath: string) => {
    if (projectBusy(projectId)) throw new Error('Wait until the current request has finished.')
    const { keptAs } = await useGitHubVersion(projectId, projectPath)
    githubNote(projectId, `⬇ Switched to GitHub's version. This computer's version is kept on the branch "${keptAs}" (here and on GitHub).`)
    const notes = undoNotes.get(projectId) ?? []
    notes.push(`The project was switched to the version on GitHub (from the user's other computer); this computer's previous version is kept on the git branch "${keptAs}". Files may have changed since you last saw them.`)
    undoNotes.set(projectId, notes)
    autoProblems.delete(projectId)
    githubChanged(projectId)
    return { keptAs }
  })
  ipc.handle('vibe:github:account', () => githubAccount())
  ipc.handle('vibe:github:repos', () => listRepos())
  // Where a downloaded project goes unless the user picks somewhere: next to the most recent project.
  ipc.handle('vibe:github:defaultFolder', () => {
    const recent = listProjects()[0]
    const docs = app.getPath('documents')
    return recent && existsSync(dirname(recent.path)) ? dirname(recent.path) : docs
  })
  ipc.handle('vibe:github:pickFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipc.handle('vibe:github:clone', async (_event, repo: string, parent: string) => {
    const folder = await cloneRepo(String(repo ?? ''), String(parent ?? ''))
    await ensureRepo(folder)
    const record = recordProjectOpened(folder)
    // A downloaded project keeps itself in step with GitHub from the start.
    if (record.githubAutoBackup === undefined) setGitHubAutoBackup(record.id, true)
    return getProject(record.id) ?? record
  })

  // Backups of VibeApp's own data.
  ipc.handle('vibe:backup:status', () => ({ dir: backupDir(), defaultDir: defaultBackupDir(), backups: listBackups() }))
  ipc.handle('vibe:backup:now', () => backupNow('manual'))
  ipc.handle('vibe:backup:export', (_event, folder: string) => backupNow('export', String(folder ?? '')))
  ipc.handle('vibe:backup:restore', (_event, path: string) => {
    const info = stageRestore(String(path ?? ''))
    // Applied as VibeApp starts again, before anything opens the data.
    setTimeout(() => {
      app.relaunch()
      app.quit()
    }, 500)
    return info
  })

  // Phone alerts (ntfy).
  ipc.handle('vibe:phone:setup', () => {
    const s = getSettings()
    const topic = s.phoneAlertTopic || newTopic()
    const next = updateSettings({ phoneAlertTopic: topic, phoneAlertServer: s.phoneAlertServer || DEFAULT_NTFY_SERVER })
    getSender()?.send('vibe:settings:changed', next)
    return { topic, url: topicUrl(next.phoneAlertServer, topic) }
  })
  ipc.handle('vibe:phone:newTopic', () => {
    const next = updateSettings({ phoneAlertTopic: newTopic() })
    getSender()?.send('vibe:settings:changed', next)
    return { topic: next.phoneAlertTopic, url: topicUrl(next.phoneAlertServer, next.phoneAlertTopic ?? '') }
  })
  ipc.handle('vibe:phone:test', () => sendPhoneAlert('VibeApp test alert', 'Phone alerts are working. You will hear from VibeApp when something needs you.', { force: true }))

  // Starts an installed extension the way the agents do and makes sure it really works.
  // (Also run right after installing, so the first agent to use it doesn't wait for the download.)
  ipc.handle('vibe:extensions:check', async (_event, id: string): Promise<ExtensionCheck> => {
    const ext = extensionLaunch(id)
    if (!ext) return { ok: false, error: "That extension isn't installed any more." }
    // Playwright starts fine without a usable browser, so open a page to be sure.
    const probe: SelfTestProbe | undefined = ext.args.some((a) => /@playwright\/mcp\b/.test(a))
      ? {
          tool: 'browser_navigate',
          arguments: { url: 'data:text/html,<title>VibeApp check</title><p>ok</p>' },
          doing: 'opening a test page in the browser'
        }
      : undefined
    const result = await selfTestServer(ext.command, ext.args, ext.env, tmpdir(), probe)
    return result.ok ? { ok: true, tools: result.tools.length } : { ok: false, error: result.error }
  })
  ipc.handle('vibe:extensions:remove', (_event, id: string) => {
    removeExtension(id)
    refreshExtensionsForAllSessions()
  })

  ipc.handle('vibe:settings:get', () => getSettings())

  ipc.handle('vibe:settings:update', async (_event, patch: Partial<AppSettings>) => {
    const before = getSettings()
    const next = updateSettings(patch)
    if ('claudeModel' in patch && next.claudeModel !== before.claudeModel) {
      await setModelForAllSessions(next.claudeModel)
    }
    if ('remoteAccess' in patch || 'remotePort' in patch) await applyRemoteSettings()
    // Every other window (the app, remote browsers) shows the change too, or
    // each kept showing what it loaded (the slider said "Auto" on one screen
    // and "Codex-led" on another).
    getSender()?.send('vibe:settings:changed', next)
    return next
  })

  ipc.handle('vibe:models:claude', () => listClaudeModels())
  ipc.handle('vibe:models:codex', () => listCodexModels())

  ipc.handle('vibe:themes:list', () => listThemes())
  ipc.handle('vibe:themes:delete', (_event, id: string) => deleteTheme(id))
  ipc.handle('vibe:themes:generate', (_event, description: string) => generateTheme(description))
  ipc.handle('vibe:themes:openFolder', () => shell.openPath(themesDir()))

  ipc.handle('vibe:usage:summary', (_event, days: number, projectId?: string) =>
    usageSummary(memoryDb(), new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString(), projectId || undefined)
  )
  // Per request: mode, route, Claude's steps by kind, hand-offs, Claude and Codex tokens.
  ipc.handle('vibe:usage:requests', (_event, days: number, projectId?: string) =>
    listRequests(memoryDb(), new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString(), projectId || undefined)
  )
  // Cline (a third agent on the user's ClinePass plan): installed? and a quick live check.
  // New versions on GitHub Releases.
  ipc.handle('vibe:update:state', () => updateState())
  ipc.handle('vibe:update:check', () => checkForUpdate())
  ipc.handle('vibe:update:install', (_event, anyway?: boolean) => installUpdate(workingProjects(), !!anyway))

  ipc.handle('vibe:cline:status', () => clineStatus())
  // The ClinePass models Cline offers now, for the Settings menus (opens a session, sends nothing).
  ipc.handle('vibe:cline:models', (_event, refresh?: boolean) => listClineModels(!!refresh))
  ipc.handle('vibe:cline:check', async () => checkCline(await clineModelFor('helper')))

  // The same, written up: by project, by kind of work, teamwork, the most expensive requests.
  ipc.handle('vibe:usage:report', async (_event, days: number, projectId?: string) => {
    const span = Math.max(1, Math.min(90, Number(days) || 7))
    const since = new Date(Date.now() - span * 86_400_000).toISOString()
    const projects = listProjects()
    const only = projectId ? projects.find((p) => p.id === projectId || p.name.toLowerCase() === String(projectId).toLowerCase()) : undefined
    if (projectId && !only) throw new Error(`No project called "${projectId}".`)
    const usage = usageByProject(memoryDb(), since).filter((u) => !only || u.projectId === only.id)
    const plans: string[] = []
    for (const cli of ['claude', 'codex'] as const) {
      const u = await getUsage(cli).catch(() => null)
      for (const w of u?.windows ?? []) plans.push(`${cli === 'claude' ? 'Claude' : 'Codex'} ${w.label} ${w.usedPercent}% used`)
    }
    return buildReport({
      days: span,
      usage,
      requests: listRequests(memoryDb(), since, only?.id),
      projectNames: new Map(projects.map((p) => [p.id, p.name])),
      plans,
      only: only?.name
    })
  })

  ipc.handle('vibe:usage:get',(_event, cli: CliName, force?: boolean) => getUsage(cli, force))

  previewEvents.on('state', (projectId: string, state: PreviewState) => {
    getSender()?.send('vibe:preview:state', projectId, state)
  })
  previewEvents.on('problem', (projectId: string, problem: PreviewProblem) => {
    getSender()?.send('vibe:preview:problem', projectId, problem)
  })
  ipc.handle('vibe:preview:start', (_event, projectId: string, projectPath: string) =>
    getPreview(projectId, projectPath).start()
  )
  ipc.handle('vibe:preview:stop', (_event, projectId: string) => findPreview(projectId)?.stop())
  ipc.handle(
    'vibe:preview:state',
    (_event, projectId: string): PreviewState => findPreview(projectId)?.getState() ?? { status: 'idle' }
  )
  ipc.handle('vibe:preview:log', (_event, projectId: string) => findPreview(projectId)?.getLog() ?? '')

  // Changing secrets restarts whatever uses them: Claude's session (after
  // its current turn) and a running preview.
  function secretsChanged(projectId: string): void {
    getSession(projectId)?.refreshSecrets()
    const preview = findPreview(projectId)
    const status = preview?.getState().status
    if (status === 'running' || status === 'starting') preview!.start().catch(() => undefined)
  }
  ipc.handle('vibe:secrets:list', (_event, projectId: string) => listSecrets(projectId))
  ipc.handle('vibe:secrets:set', (_event, projectId: string, name: string, value: string) => {
    const saved = setSecret(projectId, name, value)
    secretsChanged(projectId)
    return saved
  })
  ipc.handle('vibe:secrets:delete', (_event, projectId: string, name: string) => {
    deleteSecret(projectId, name)
    secretsChanged(projectId)
  })

  ipc.handle('vibe:publish:status', (_event, projectId: string, projectPath: string) =>
    publishStatus(projectId, projectPath)
  )
  ipc.handle(
    'vibe:publish:github',
    (_event, projectId: string, projectPath: string, options: { name: string; visibility: 'private' | 'public' }) =>
      publishToGitHub(projectId, projectPath, options)
  )
  ipc.handle('vibe:publish:ghInstall', () => wireInstallSession(startGhInstallSession()))
  ipc.handle('vibe:publish:ghLogin', () => wireInstallSession(startTerminalSession(ghLoginSessionOptions())))

  ipc.handle('vibe:publish:vercelLogin', async () => {
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
  ipc.handle(
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
  ipc.handle('vibe:publish:vercelResult', (_event, sessionId: string) => {
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

/** Above this conversation size, small requests keep the current model rather than breaking the prompt cache. */
const CACHE_KEEP_TOKENS = 30_000

/** Folders inside `dir` (or the drives and home folder when no dir is given), for the browser's folder picker. */
function listDirs(dir?: string): { path: string; parent: string | null; dirs: { name: string; path: string }[] } {
  if (!dir) {
    const roots: { name: string; path: string }[] = [{ name: 'Home', path: homedir() }]
    if (process.platform === 'win32') {
      for (const letter of 'CDEFGHIJ') if (existsSync(`${letter}:\\`)) roots.push({ name: `${letter}:`, path: `${letter}:\\` })
    } else roots.push({ name: '/', path: '/' })
    return { path: '', parent: null, dirs: roots }
  }
  const dirs: { name: string; path: string }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || /^(node_modules|\$Recycle\.Bin|System Volume Information)$/i.test(entry.name)) continue
    dirs.push({ name: entry.name, path: join(dir, entry.name) })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  const parent = dirname(dir)
  return { path: dir, parent: parent === dir ? '' : parent, dirs: dirs.slice(0, 500) }
}

/** Context size (tokens) past which a long conversation moves to a fresh session, if that's enabled. */
function rotateThreshold(): number {
  // The override is for testing; Claude Code's own prompt is ~40k of this.
  return Number(process.env.VIBEAPP_ROTATE_TOKENS) || getSettings().rotateAtTokens || 120_000
}

/** A project's name, for alerts. */
function projectName(projectId: string): string {
  return getProject(projectId)?.name ?? 'A project'
}

// ---- the to-do list and notes ------------------------------------------------------

/** Per project: the to-do being worked on by the current request ("Build this"). */
const turnTodos = new Map<string, { id: string; failed?: boolean; carried?: boolean }>()
let sendTodosChanged: (projectId: string) => void = () => undefined

/** Tells every window (and remote browser) that a project's to-do list changed. */
function todosChanged(projectId: string): void {
  sendTodosChanged(projectId)
}

/**
 * The agents add and tick off to-dos from their own memory-tool processes,
 * which share the database but not this process: notice their changes too.
 */
function watchTodos(): void {
  let last = todosSignature(memoryDb())
  setInterval(() => {
    try {
      const next = todosSignature(memoryDb())
      for (const id of new Set([...last.keys(), ...next.keys()])) if (last.get(id) !== next.get(id)) todosChanged(id)
      last = next
    } catch (err) {
      console.warn('Checking the to-do lists failed:', (err as Error).message)
    }
  }, 2_000).unref()
}

// ---- plan progress ------------------------------------------------------------------

/** Per project: the plan being built, and how far each step has got. */
const buildingPlans = new Map<string, { steps: ReturnType<typeof parsePlanSteps>; state: ('doing' | 'done' | undefined)[]; stopped?: boolean }>()
/** Per project: the last plan proposed, so "Change it" can revise it even when Codex made it. */
const lastPlans = new Map<string, string>()

/** Per project: the plan file Claude Code wrote this conversation's plan to. */
const planFiles = new Map<string, string>()

/** A file in Claude Code's own plans folder (the only kind VibeApp ever deletes). */
/**
 * Claude Code keeps one plan file per conversation and has Claude read it
 * before every new plan. Once a plan is built or cancelled the old text is
 * only in the way ("this is a stale plan..."), so remove it: the next plan
 * starts from a clean slate.
 */
function clearPlanFile(projectId: string): void {
  const file = planFiles.get(projectId)
  planFiles.delete(projectId)
  if (!file || !isPlanFile(file)) return
  try {
    rmSync(file, { force: true })
  } catch (err) {
    console.warn('Clearing the old plan failed:', (err as Error).message)
  }
}

function startPlanBuild(projectId: string, plan: string): void {
  const steps = parsePlanSteps(plan)
  buildingPlans.set(projectId, { steps, state: steps.map(() => undefined) })
}

/** Records a step's progress; returns true if it moved forward (so it's worth showing). */
function noteStep(projectId: string, step: number, status: 'doing' | 'done'): boolean {
  const plan = buildingPlans.get(projectId)
  if (!plan || step < 1 || step > plan.steps.length) return false
  const was = plan.state[step - 1]
  if (was === 'done' || was === status) return false
  plan.state[step - 1] = status
  return true
}

/** Codex makes the plan (read-only) when Claude is out; it's shown like Claude's, marked as Codex's. */
async function runCodexPlan(
  session: ReturnType<typeof getOrCreateSession>,
  projectId: string,
  projectPath: string,
  text: string
): Promise<void> {
  const emit = (event: VibeEvent): void => void session.emit('event', event)
  const abort = new AbortController()
  takeovers.set(projectId, abort)
  const toolUseId = `codex-plan-${Date.now()}`
  try {
    emit({ type: 'route', label: 'Planned by Codex', reason: 'Claude is out right now; nothing changes until you approve' })
    emit({
      type: 'tool_call',
      toolUseId,
      name: 'mcp__vibe_tools__run_codex_subtask',
      input: { prompt: text },
      friendlyLabel: 'Codex is planning (looking only, changing nothing)'
    })
    const previous = lastPlans.get(projectId)
    let facts = ''
    try {
      facts = keyFactsBlock(memoryDb(), projectId)
    } catch {
      // memory unavailable: plan without it
    }
    const brief = briefBlock(projectId)
    const prompt = [
      PLAN_INSTRUCTIONS,
      'You can read the project but must not change anything. Reply with the plan only, in Markdown.',
      facts ? `Key facts about the project:\n${facts}` : '',
      brief ? `Project brief:\n${brief}` : '',
      previous ? `The previous plan (the user has asked for changes to it):\n${previous}` : '',
      `The user's request:\n${text}`
    ]
      .filter(Boolean)
      .join('\n\n')
    const result = await runCodexExec(
      {
        prompt,
        cwd: projectPath,
        readOnly: true,
        ephemeral: true,
        model: getSettings().codexModel ?? undefined,
        effort: getSettings().codexEffort ?? undefined,
        timeoutMs: 10 * 60_000,
        signal: abort.signal
      },
      undefined,
      (activity) => emit({ type: 'delegation_activity', activity })
    )
    recordUsage(projectId, 'takeover', 'codex', countsFromCodexEvents(result.events))
    const plan = result.finalMessage.trim()
    emit({ type: 'tool_result', toolUseId, ok: !!plan, summary: plan ? 'Plan ready.' : 'Codex returned no plan.', raw: null })
    if (!plan) throw new Error(codexFailure(result) ?? 'Codex returned no plan.')
    lastPlans.set(projectId, plan)
    emit({ type: 'plan_proposed', toolUseId: `${toolUseId}-plan`, plan, steps: parsePlanSteps(plan), by: 'codex' })
  } catch (err) {
    if (abort.signal.aborted) emit({ type: 'stopped' })
    else emit({ type: 'error', message: `Codex couldn't make a plan: ${(err as Error).message}` })
  } finally {
    takeovers.delete(projectId)
    emit({ type: 'turn_complete' })
  }
}

/** Keeps an approved plan's steps in memory, so a compaction or a fresh session knows what was agreed. */
function rememberApprovedPlan(projectId: string, plan: string): void {
  try {
    const steps = parsePlanSteps(plan)
    const summary = steps.length
      ? steps.map((s, i) => `${i + 1}. ${s.who ? `(${s.who}) ` : ''}${s.text}`).join(' ')
      : plan.replace(/s+/g, ' ')
    rememberFact(memoryDb(), projectId, `Plan the user approved: ${summary}`.slice(0, 950), 'user', { category: 'decision' })
  } catch (err) {
    console.warn('Saving the approved plan failed:', (err as Error).message)
  }
}

/** Undo/Redo presses since Claude last heard from the user, told to it with the next message. */
const undoNotes = new Map<string, string[]>()

function takeUndoNote(projectId: string): string | undefined {
  const notes = undoNotes.get(projectId)
  undoNotes.delete(projectId)
  return notes?.length ? `[VibeApp note: ${notes.join(' ')} Check the files rather than relying on what was done before.]` : undefined
}

/**
 * Questions answered the cheap way (Ask mode, or a plain question typed in
 * Build) run outside the project's Claude conversation, so a follow-up like
 * "OK, fix it" would reach a Claude that never saw them. The last couple are
 * kept here and passed along, short, with the next Build or Plan message.
 */
const recentAsks = new Map<string, { question: string; answer: string; at: number }[]>()
const ASK_NOTE_MAX_AGE_MS = 3 * 60 * 60 * 1000

function noteAsk(projectId: string, question: string, answer: string): void {
  const list = [...(recentAsks.get(projectId) ?? []), { question, answer, at: Date.now() }]
  recentAsks.set(projectId, list.slice(-2))
}

function freshAsks(projectId: string): { question: string; answer: string }[] {
  return (recentAsks.get(projectId) ?? []).filter((a) => Date.now() - a.at < ASK_NOTE_MAX_AGE_MS)
}

/** The questions alone, so the request can be judged (routed) in context. */
function peekAskQuestions(projectId: string): string | undefined {
  const asks = freshAsks(projectId)
  return asks.length ? asks.map((a) => a.question).join('\n') : undefined
}

function takeAskNote(projectId: string): string | undefined {
  const note = askNoteText(freshAsks(projectId))
  recentAsks.delete(projectId)
  return note
}

/** A manually started fresh session's summary, delivered with the next message. */
const pendingCarry = new Map<string, string>()

/**
 * Moves the project's chat into a brand-new Claude session seeded with a
 * summary (only between requests). Returns the note the new session starts
 * with, or undefined if nothing changed (no summary, or a request is running).
 */
/**
 * The last chance to save what only the conversation knows (procedures,
 * rules, decisions) and to bring the project brief up to date, before the
 * conversation is compacted or left behind. Never throws: neither step may
 * stop the shrinking.
 */
async function saveBeforeShrinking(projectId: string): Promise<void> {
  ensureHistoryImported(projectId)
  try {
    // Only when the user lets VibeApp save memory by itself.
    if (getSettings().autoMemory) await runSavePass(projectId)
  } catch (err) {
    console.warn('Save pass before shrinking the conversation failed:', (err as Error).message)
  }
  const projectPath = getProject(projectId)?.path
  if (projectPath) {
    try {
      // Only if something changed since it was written (it used to be rewritten before every compaction).
      await refreshBrief(projectId, projectPath, { minChanges: 1 })
    } catch (err) {
      console.warn('Project brief refresh failed:', (err as Error).message)
    }
  }
}

/** What Claude Code's summary must keep when VibeApp compacts a conversation. */
const COMPACT_INSTRUCTIONS =
  "Write the summary so the work can continue without the history. Keep, as exactly as possible: the user's standing rules (anything they said never or always to do, files or areas not to touch); how the project is run, tested and deployed, with the commands that worked; servers, services, hosts and environments; decisions made and why; what is in progress and what is next; open questions; the file paths that matter. Drop exploration details, file contents that can be re-read, and attempts that were superseded. The project brief and remembered facts are kept separately, so don't pad the summary with general background."

/** Compacts the conversation in place, after saving what it alone knows. */
async function compactWithSafeguards(
  session: ReturnType<typeof getOrCreateSession>,
  projectId: string
): Promise<CompactResult | null> {
  await saveBeforeShrinking(projectId)
  return session.compact(COMPACT_INSTRUCTIONS)
}

async function rotateWithSummary(
  session: ReturnType<typeof getOrCreateSession>,
  projectId: string
): Promise<string | undefined> {
  await saveBeforeShrinking(projectId)
  const summary = await summarizeConversation(projectId)
  if (!summary || !session.rotate(summary)) return undefined
  return `[VibeApp note: this is a fresh session continuing earlier work, started to keep things fast. Summary of the conversation so far:\n${summary}\nTreat the STANDING RULES in it as binding. The history tool (mcp__vibe_memory__history) has the details; check it before assuming something wasn't discussed.]`
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
/** Running questions (Ask mode), and each project's Claude session for follow-ups. */
const asks = new Map<string, AbortController>()
const askSessions = new Map<string, string>()
const askTurns = new Map<string, number>()
/** Questions answered in one Ask session before the next one starts afresh. */
const MAX_ASK_TURNS = 6
/** Running takeovers; aborting one stops Codex. */
const takeovers = new Map<string, AbortController>()

/** Answers a question about the project without changing anything (Ask mode, or a plain question sent from Build). */
function runAsk(
  projectId: string,
  projectPath: string,
  text: string,
  getSender: () => WebContents | undefined,
  auto: boolean
): void {
  const emit = (event: VibeEvent): void => {
    appendEvent(projectId, event)
    getSender()?.send('vibe:chat:event', projectId, event)
  }
  if (asks.has(projectId) || takeovers.has(projectId)) {
    // Say so and end the turn, or the chat would wait for an answer that never comes.
    emit({ type: 'error', message: 'Still working on the previous request; ask again when it has finished.' })
    emit({ type: 'turn_complete' })
    return
  }
  const abort = new AbortController()
  asks.set(projectId, abort)
  appendUserMessage(projectId, text)
  recordUserMessage(projectId, text, 'asked as a question')
  emit(
    auto
      ? { type: 'route', label: 'Answered as a question', reason: 'cheaper than a build request; no files changed' }
      : { type: 'route', label: 'Question', reason: 'answered without changing any files' }
  )
  void (async () => {
    try {
      const keyFacts = keyFactsBlock(memoryDb(), projectId)
      const relevant = prefetchBlock(projectId, text)
      const chosen = getSettings().claudeModel
      const system = `You are answering a question about the user's software project inside VibeApp. You can't change the project's files: you can only read and search them and look things up in the project's memory. You can look at and update the user's to-do list for this project (add items, tick them off) and read their notes, when they ask. Answer directly in plain, friendly language and keep it short unless asked for depth. If the question turns out to need changes to the project, say so and suggest they switch to Build mode.\n\n## Key facts\n${keyFacts}`
      const prompt = [relevant, text].filter(Boolean).join('\n\n')
      let answer
      const blocked = claudeBlockedUntil() !== null
      if (!blocked) {
        try {
          answer = await askClaude({
            prompt,
            cwd: projectPath,
            system,
            // Cheap by default; never Opus for a question.
            model: !chosen ? 'haiku' : /opus/i.test(chosen) ? 'sonnet' : chosen,
            abort,
            readFiles: true,
            memory: {
              scriptPath: memoryServerScriptPath(),
              dbPath: memoryDbPath(),
              projectId,
              projectPath
            },
            resume: askSessions.get(projectId)
          })
          // Follow-up questions continue the same session, but only for a few: each one re-reads it all.
          const asked = (askTurns.get(projectId) ?? 0) + 1
          if (answer.sessionId && asked < MAX_ASK_TURNS) {
            askSessions.set(projectId, answer.sessionId)
            askTurns.set(projectId, asked)
          } else {
            askSessions.delete(projectId)
            askTurns.delete(projectId)
          }
          recordUsage(projectId, 'chat', 'claude', answer.counts)
        } catch (err) {
          if (!(err instanceof ClaudeLimitError)) throw err
          noteClaudeLimit(null)
        }
      }
      if (!answer) {
        // Claude is out: Codex answers instead, read-only.
        answer = await askCodex({
          prompt: `${system}

${prompt}`,
          cwd: projectPath,
          model: getSettings().codexModel ?? undefined,
          effort: getSettings().codexEffort ?? undefined,
          memory: { scriptPath: memoryServerScriptPath(), dbPath: memoryDbPath(), projectId, projectPath },
          abort
        })
        recordUsage(projectId, 'chat', 'codex', answer.counts)
        emit({ type: 'route', label: 'Answered by Codex', reason: 'Claude is out right now' })
      }
      recordAssistantMessage(projectId, answer.text)
      noteAsk(projectId, text, answer.text)
      emit({ type: 'assistant_text', text: answer.text, partial: false })
    } catch (err) {
      if (abort.signal.aborted) emit({ type: 'stopped' })
      else emit({ type: 'error', message: `Couldn't answer that: ${(err as Error).message}` })
    } finally {
      asks.delete(projectId)
      emit({ type: 'turn_complete' })
    }
  })()
}

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
    snapshot: request.snapshot,
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

/** The request each project is running, being recorded for the usage report. */
const requestLogs = new Map<string, RequestRecorder>()

function startRequestLog(start: RequestStart): void {
  requestLogs.set(start.projectId, new RequestRecorder(start))
}

function observeRequestLog(projectId: string, event: VibeEvent): void {
  const recorder = requestLogs.get(projectId)
  if (!recorder || !recorder.observe(event)) return
  requestLogs.delete(projectId)
  try {
    const db = memoryDb()
    const since = recorder.startedAt.toISOString()
    logRequest(db, recorder.finish(codexUsageSince(db, projectId, since), agentUsageSince(db, projectId, since, 'cline')))
  } catch (err) {
    console.warn('Recording the request failed:', (err as Error).message)
  }
}

/**
 * Runs the project's saved Deploy (no AI), for the Deploy button, schedules
 * and Claude's run_deploy tool. The result goes in the chat; when the user
 * started it, Claude hears about it with the next message, like an Undo.
 * Throws before starting if it can't run.
 */
async function deployNow(
  projectId: string,
  projectPath: string,
  by: 'user' | 'claude',
  getSender: () => WebContents | undefined
): Promise<DeployResult & { name: string }> {
  const recipe = getRecipe(projectId)
  if (!recipe) throw new Error('This project has no saved Deploy yet.')
  if (!recipe.confirmed) throw new Error('Check the deploy recipe and save it before running it.')
  if (isDeploying(projectId)) throw new Error('A deploy is already running for this project.')
  const post = (event: VibeEvent): void => {
    appendEvent(projectId, event)
    getSender()?.send('vibe:chat:event', projectId, event)
  }
  let result: DeployResult
  try {
    result = await runDeploy(projectId, projectPath)
  } catch (err) {
    post({ type: 'deploy_result', name: recipe.name, ok: false, seconds: 0, failedStep: 'Starting', detail: (err as Error).message })
    throw err
  }
  post({
    type: 'deploy_result',
    name: recipe.name,
    ok: result.ok,
    seconds: result.seconds,
    failedStep: result.failedStep,
    detail: result.checkDetail,
    rolledBack: result.rolledBack,
    stopped: result.stopped
  })
  if (by === 'user') {
    const notes = undoNotes.get(projectId) ?? []
    notes.push(
      result.ok
        ? `The user deployed with the Deploy button ("${recipe.name}") and it succeeded${result.checkDetail ? ` (${result.checkDetail})` : ''}.`
        : `The user ran the Deploy button ("${recipe.name}") and it ${result.stopped ? 'was stopped' : `failed at "${result.failedStep}"`}${result.rolledBack ? '; the rollback steps ran' : ''}.${result.output ? ` Last output:\n${result.output.slice(-1200)}` : ''}`
    )
    undoNotes.set(projectId, notes)
  }
  notifyUser(
    result.ok ? `${projectName(projectId)}: deployed` : `${projectName(projectId)}: deploy failed`,
    result.ok ? `${recipe.name} is live (${result.seconds}s).` : `${result.stopped ? 'Stopped' : `Failed at "${result.failedStep}"`}${result.rolledBack ? '; rolled back' : ''}.`
  )
  return { ...result, name: recipe.name }
}

/** What Claude's run_deploy tool tells it. */
async function deployForClaude(
  projectId: string,
  projectPath: string,
  getSender: () => WebContents | undefined
): Promise<{ ok: boolean; text: string }> {
  try {
    const r = await deployNow(projectId, projectPath, 'claude', getSender)
    if (r.ok) return { ok: true, text: `Deployed with "${r.name}" in ${r.seconds}s${r.checkDetail ? ` (${r.checkDetail})` : ''}. The result is in the user's chat.` }
    return {
      ok: false,
      text: `"${r.name}" ${r.stopped ? 'was stopped by the user' : `failed at "${r.failedStep}"`}${r.rolledBack ? '; the rollback steps ran, so the previous version is live' : ''}.${r.checkDetail ? ` ${r.checkDetail}.` : ''}${r.output ? `\nLast output:\n${r.output.slice(-1500)}` : ''}`
    }
  } catch (err) {
    const message = (err as Error).message
    const recipe = getRecipe(projectId)
    const hint = !recipe
      ? ' Offer to write one with save_deploy_recipe from how this project was deployed before.'
      : !recipe.confirmed
        ? ' The user needs to check it in the Deploy window (🚀 Deploy) and save it first; tell them.'
        : ''
    return { ok: false, text: `Didn't deploy: ${message}${hint}` }
  }
}

const wiredSessions = new WeakSet<object>()

function wireSessionEvents(
  session: ReturnType<typeof getOrCreateSession>,
  projectId: string,
  getSender: () => WebContents | undefined
): void {
  if (wiredSessions.has(session)) return
  wiredSessions.add(session)
  // If Claude Code compacts on its own (near its limit), save first.
  session.beforeAutoCompact = () => saveBeforeShrinking(projectId)
  session.deployRunner = () => {
    const path = getProject(projectId)?.path
    return path ? deployForClaude(projectId, path, getSender) : Promise.resolve({ ok: false, text: 'Deploy is not available here.' })
  }

  session.on('event', (event: VibeEvent) => {
    if (event.type === 'claude_limit') {
      const todo = turnTodos.get(projectId)
      if (todo) todo.carried = true
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

      // Plans: remember the latest one, and while one is being built, keep its checklist
      // moving from whichever signal arrives: the progress tool, Claude's own to-do list,
      // or "STEP 2: done" lines (how Codex reports).
      if (forwarded.type === 'plan_proposed') lastPlans.set(projectId, forwarded.plan)
      // Where Claude Code keeps this conversation's plan, to clear it once the plan is done with.
      if (forwarded.type === 'tool_call' && (forwarded.name === 'Write' || forwarded.name === 'Edit')) {
        const file = (forwarded.input as { file_path?: string } | undefined)?.file_path
        if (file && isPlanFile(file)) planFiles.set(projectId, file)
      }
      const building = buildingPlans.get(projectId)
      if (building) {
        const updates: { step: number; status: 'doing' | 'done' }[] = []
        if (forwarded.type === 'plan_progress') {
          noteStep(projectId, forwarded.step, forwarded.status)
        } else if (forwarded.type === 'tool_call' && forwarded.name === 'TodoWrite') {
          const todos = (forwarded.input as { todos?: { content: string; status: string }[] } | undefined)?.todos ?? []
          matchTodosToSteps(todos, building.steps).forEach((status, i) => status && updates.push({ step: i + 1, status }))
        } else if (forwarded.type === 'delegation_activity' && forwarded.activity.step === 'say') {
          updates.push(...progressMarkers(forwarded.activity.text))
        } else if (forwarded.type === 'assistant_text') {
          updates.push(...progressMarkers(forwarded.text))
        } else if (forwarded.type === 'stopped' || forwarded.type === 'error') {
          building.stopped = true
        }
        for (const u of updates) {
          if (noteStep(projectId, u.step, u.status)) session.emit('event', { type: 'plan_progress', ...u } satisfies VibeEvent)
        }
      }

      // What happened this request, for the scribe.
      const record = turnRecords.get(projectId)
      if (record) {
        if (forwarded.type === 'assistant_text') record.replies.push(forwarded.text)
        else if (forwarded.type === 'tool_call') {
          record.actions.push(forwarded.friendlyLabel.slice(0, 160))
          // The commands themselves, for saving how things are done.
          const command =
            forwarded.name === 'Bash' || forwarded.name === 'PowerShell'
              ? (forwarded.input as { command?: string } | undefined)?.command
              : undefined
          if (command && isNotableCommand(command)) record.commands?.push(cleanCommand(command))
        } else if (forwarded.type === 'delegation_activity') {
          const a = forwarded.activity
          if (a.step === 'run' && a.done && a.ok !== false) {
            const command = a.full ?? a.text
            if (isNotableCommand(command)) record.commands?.push(cleanCommand(command))
          }
        }
        else if (forwarded.type === 'error') record.hadError = true
        else if (forwarded.type === 'stopped') record.stopped = true
      }

      // A to-do sent with "Build this": ticked off when its request finishes properly.
      const todo = turnTodos.get(projectId)
      if (todo) {
        if (forwarded.type === 'stopped' || forwarded.type === 'error') todo.failed = true
        else if (forwarded.type === 'turn_complete') {
          if (todo.carried) {
            // Codex takes the request over; it's ticked off when Codex finishes.
            todo.carried = false
          } else {
            turnTodos.delete(projectId)
            if (!todo.failed && updateTodo(memoryDb(), projectId, todo.id, { done: true })) todosChanged(projectId)
          }
        }
      }

      // Between requests is a good moment to save what was learned, tidy
      // memory and refresh the code map, if they need it.
      if (forwarded.type === 'turn_complete') {
        const path = getProject(projectId)?.path
        const finished = turnRecords.get(projectId)
        turnRecords.delete(projectId)
        // A plan's build is over: say honestly how many of its steps were reported.
        const built = buildingPlans.get(projectId)
        if (built) {
          buildingPlans.delete(projectId)
          clearPlanFile(projectId)
          session.emit('event', {
            type: 'plan_finished',
            total: built.steps.length,
            tracked: built.state.filter((s) => s === 'done').length,
            stopped: !!(built.stopped || finished?.stopped || finished?.hadError)
          } satisfies VibeEvent)
        }
        if (finished && getSettings().autoMemory) {
          // On Cline when it's set up, otherwise Haiku if Claude has room.
          helpersAllowed()
            .then((allowed) => (allowed ? runScribe(projectId, finished) : undefined))
            .catch((err: Error) => console.warn('Saving memory failed:', err.message))
            .finally(() => {
              if (path) syncAgentsFile(projectId, path)
              maybeTidy(projectId)
              maybeTidy(GLOBAL_SCOPE)
              if (path) maybeRefreshBrief(projectId, path)
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
