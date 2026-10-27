import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ConfirmationRequest,
  DelegationActivity,
  ImageAttachment,
  PickedElement,
  PreviewProblem,
  ProjectRecord,
  QuestionAnswers,
  ReviewFinding,
  SecretLeak,
  VibeEvent
} from '@shared/types'
import CheckpointButton from '../components/CheckpointButton'
import GoNutzToggle from '../components/GoNutzToggle'
import PreviewPane from '../components/PreviewPane'
import NotesPane from '../components/NotesPane'
import DeployDialog from '../components/DeployDialog'
import ScheduleDialog from '../components/ScheduleDialog'
import GitHubSyncBanner from '../components/GitHubSyncBanner'
import SecretsDialog from '../components/SecretsDialog'
import PublishDialog from '../components/PublishDialog'
import Modal from '../components/Modal'
import QuestionCard from '../components/QuestionCard'
import { shortenProjectPaths } from '../lib/labels'
import CodexFeed from '../components/CodexFeed'
import Markdown from '../components/Markdown'
import { detectSecrets, type DetectedSecret } from '@shared/secretPatterns'
import { usePhone } from '../lib/usePhone'
import PlanCard from '../components/PlanCard'

interface ChatViewProps {
  project: ProjectRecord
  onBack: () => void
  onOpenHistory: () => void
  onError: (message: string) => void
  thinkingLabel: string
}

type ChatItem =
  | { kind: 'user_text'; text: string; snapshot?: string; attachment?: string; images?: string[] }
  | { kind: 'assistant_text'; text: string }
  | {
      kind: 'tool'
      toolUseId: string
      label: string
      status: 'running' | 'ok' | 'error'
      summary?: string
      isDelegation: boolean
      progressNote?: string
      /** Codex's steps during a hand-off. */
      activity?: DelegationActivity[]
      /** What a helper agent (started by this call) did, step by step. */
      substeps?: { toolUseId: string; label: string; status: 'running' | 'ok' | 'error' }[]
      startedAt?: number
    }
  | { kind: 'error'; message: string }
  | { kind: 'notice'; text: string; details?: string }
  | { kind: 'deploy_ready'; name: string; steps: number }
  | { kind: 'schedule_ready'; scheduleId: string; name: string; summary: string }
  | { kind: 'route'; label: string; reason: string; detail?: string }
  | { kind: 'restore'; text: string; restoreTo?: string; actionLabel?: string }
  | { kind: 'usage'; text: string }
  | {
      kind: 'plan'
      toolUseId: string
      plan: string
      steps: { text: string; who?: 'claude' | 'codex' }[]
      status: 'pending' | 'approved' | 'revised' | 'cancelled'
      /** While it's being built: each step's progress (by step number). */
      progress: Record<number, 'doing' | 'done'>
      by?: 'claude' | 'codex'
      /** Its build ended: how many steps were reported along the way. */
      finished?: { total: number; tracked: number; stopped: boolean }
    }
  | { kind: 'plan_suggestion'; text: string; used?: boolean }
  | { kind: 'older'; hidden: number }
  | { kind: 'offer'; text: string; resetsAt: number | null; used?: boolean }
  | {
      kind: 'review'
      status: 'running' | 'done' | 'error'
      summary?: string
      findings?: ReviewFinding[]
      fixing?: boolean
    }

const DELEGATION_TOOL_NAME = 'mcp__vibe_tools__run_codex_subtask'
const PREVIEW_PREF_KEY = 'vibeapp.showPreview'
const SIDE_PREF_KEY = 'vibeapp.sidePane'
const ASK_PREF_KEY = 'vibeapp.askMode'
const MODE_PREF_KEY = 'vibeapp.chatMode'
/** A Build chat this big (tokens) gets a note about what each message costs. */
const CONTEXT_NOTE_TOKENS = 60_000
/** A hidden size note comes back only once the chat has grown this much more (or after compacting). */
const NOTE_RETURNS_AFTER = 30_000
/** Without auto-compact, Claude Code shrinks the conversation itself near its limit (about this size). */
const CLAUDE_CONTEXT_LIMIT = 200_000
const noteKey = (projectId: string): string => `vibeapp.costNoteHidden.${projectId}`

/** When the size note appears (the tests lower it, so they needn't grow a chat to 60k first). */
function noteThreshold(): number {
  try {
    return Number(localStorage.getItem('vibeapp.costNoteAt')) || CONTEXT_NOTE_TOKENS
  } catch {
    return CONTEXT_NOTE_TOKENS
  }
}

function readNoteHidden(projectId: string): number | null {
  try {
    const v = Number(localStorage.getItem(noteKey(projectId)))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}
/** How many of the most recent requests are shown when a chat is opened. */
const REPLAY_REQUESTS = 40

function describePicked(picked: PickedElement): string {
  const text = picked.text.trim().replace(/\s+/g, ' ').slice(0, 40)
  return `<${picked.tag}>${text ? ` "${text}"` : ''}`
}

/** An image waiting to be sent with the next message. */
interface PendingImage {
  name: string
  mediaType: string
  dataUrl: string
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

function readImageFile(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`${file.name || 'That image'} is over 20 MB.`))
      return
    }
    const reader = new FileReader()
    reader.onload = () =>
      resolve({ name: file.name || 'pasted-image', mediaType: file.type, dataUrl: String(reader.result) })
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name || 'that image'}.`))
    reader.readAsDataURL(file)
  })
}

function toAttachment(image: PendingImage): ImageAttachment {
  return { name: image.name, mediaType: image.mediaType, data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) }
}

/** 12345 -> "12.3k", 1234567 -> "1.2M" */
function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** An epoch-ms time as a short local clock time ("7:30 PM"). */
function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

type ChatMode = 'build' | 'plan' | 'ask'

function readModePref(): ChatMode {
  try {
    const saved = localStorage.getItem(MODE_PREF_KEY)
    if (saved === 'build' || saved === 'plan' || saved === 'ask') return saved
    return localStorage.getItem(ASK_PREF_KEY) === 'true' ? 'ask' : 'build'
  } catch {
    return 'build'
  }
}

type SidePane = 'preview' | 'notes'

function readSidePref(): SidePane {
  try {
    return localStorage.getItem(SIDE_PREF_KEY) === 'notes' ? 'notes' : 'preview'
  } catch {
    return 'preview'
  }
}

function readPreviewPref(): boolean {
  try {
    return localStorage.getItem(PREVIEW_PREF_KEY) !== 'false'
  } catch {
    return true
  }
}

function ChatView({ project, onBack, onOpenHistory, onError, thinkingLabel }: ChatViewProps) {
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // A queue: two destructive commands can be pending at once, and each one
  // leaves Claude waiting until it's answered.
  const [confirmations, setConfirmations] = useState<ConfirmationRequest[]>([])
  const confirmation = confirmations[0] ?? null
  const [hasChanges, setHasChanges] = useState(false)
  const [goNutz, setGoNutz] = useState(false)
  // The pane beside the chat (when showPreview is on): the live preview or the Notes tab.
  const [showPreview, setShowPreview] = useState(readPreviewPref)
  const [sidePane, setSidePaneState] = useState<SidePane>(readSidePref)
  // On a phone there's room for one pane at a time: the chat or the side pane.
  const phone = usePhone()
  const [phonePane, setPhonePane] = useState<'chat' | 'preview'>('chat')
  // A to-do sent to Plan mode: ticked off once its approved plan has been built.
  const planTodo = useRef<string | null>(null)
  // Ask: answer a question without changing anything. Build: the normal coding flow.
  // Build: work on the project. Plan: propose a plan to approve first. Ask: answer, change nothing.
  const [mode, setModeState] = useState<ChatMode>(readModePref)
  const askMode = mode === 'ask'
  const setMode = useCallback((next: ChatMode) => {
    setModeState(next)
    try {
      localStorage.setItem(MODE_PREF_KEY, next)
    } catch {
      // a remembered preference only
    }
  }, [])
  // How big this project's Claude conversation is now (tokens re-read on every Build step).
  const [contextTokens, setContextTokens] = useState(0)
  // Where auto-compact kicks in, for the context meter.
  const [compactAt, setCompactAt] = useState<{ auto: boolean; tokens: number }>({ auto: true, tokens: 120_000 })
  // The size the "this chat has grown" note was hidden at (per project, on this device).
  const [noteHiddenAt, setNoteHiddenAt] = useState<number | null>(() => readNoteHidden(project.id))
  const hideNote = useCallback(
    (tokens: number | null) => {
      setNoteHiddenAt(tokens)
      try {
        if (tokens) localStorage.setItem(noteKey(project.id), String(tokens))
        else localStorage.removeItem(noteKey(project.id))
      } catch {
        // a remembered preference only
      }
    },
    [project.id]
  )
  // Opening a chat shows its recent requests; this loads the whole log.
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<PickedElement | null>(null)
  const [problem, setProblem] = useState<PreviewProblem | null>(null)
  const [problemExpanded, setProblemExpanded] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [dialog, setDialog] = useState<'secrets' | 'publish' | 'deploy' | 'schedules' | null>(null)
  const [scheduleFocus, setScheduleFocus] = useState<string | undefined>(undefined)
  const [stopping, setStopping] = useState(false)
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [leaks, setLeaks] = useState<SecretLeak[] | null>(null)
  // A message that looked like it contained an API key, waiting on the user.
  const [pendingSecret, setPendingSecret] = useState<{
    text: string
    element?: PickedElement
    images: PendingImage[]
    found: (DetectedSecret & { saveAs: string })[]
  } | null>(null)
  const busyRef = useRef(false)
  busyRef.current = busy
  const dismissedProblems = useRef(new Set<string>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    window.vibe.chat.isGoNutzMode(project.id).then(setGoNutz)
  }, [project.id])

  const setSideOpen = useCallback((open: boolean) => {
    setShowPreview(open)
    try {
      localStorage.setItem(PREVIEW_PREF_KEY, String(open))
    } catch {
      // Only a remembered preference; fine to lose.
    }
  }, [])

  const setSidePane = useCallback((pane: SidePane) => {
    setSidePaneState(pane)
    try {
      localStorage.setItem(SIDE_PREF_KEY, pane)
    } catch {
      // Only a remembered preference; fine to lose.
    }
  }, [])

  /** The Preview and Notes buttons: open that pane, or close it if it's already showing. */
  const toggleSide = useCallback(
    (pane: SidePane) => {
      if (showPreview && sidePane === pane) {
        setSideOpen(false)
      } else {
        setSidePane(pane)
        setSideOpen(true)
      }
    },
    [showPreview, sidePane, setSideOpen, setSidePane]
  )

  const handleGoNutzChange = useCallback(
    async (enabled: boolean) => {
      await window.vibe.chat.setGoNutzMode(project.id, enabled)
      setGoNutz(enabled)
    },
    [project.id]
  )

  const refreshHasChanges = useCallback(() => {
    window.vibe.git.hasChanges(project.path).then(setHasChanges)
  }, [project.path])

  useEffect(() => {
    refreshHasChanges()
  }, [refreshHasChanges])

  const applyEvent = useCallback(
    (event: VibeEvent, isReplay = false) => {
      setItems((prev) => {
        switch (event.type) {
          case 'assistant_text':
            return [...prev, { kind: 'assistant_text', text: event.text }]
          case 'tool_call':
            // Plan bookkeeping isn't work on the project: the plan card shows it.
            if (
              event.name === 'mcp__vibe_tools__plan_progress' ||
              ((event.name === 'Write' || event.name === 'Read' || event.name === 'Edit') &&
                /[\\/]\.claude[\\/]plans[\\/]/.test(String((event.input as { file_path?: string })?.file_path ?? '')))
            ) {
              return prev
            }
            if (event.parentToolUseId) {
              // A helper agent's step: shown inside the card that started it.
              return prev.map((item) =>
                item.kind === 'tool' && item.toolUseId === event.parentToolUseId
                  ? {
                      ...item,
                      substeps: [
                        ...(item.substeps ?? []),
                        { toolUseId: event.toolUseId, label: event.friendlyLabel, status: 'running' as const }
                      ].slice(-60)
                    }
                  : item
              )
            }
            return [
              ...prev,
              {
                kind: 'tool',
                toolUseId: event.toolUseId,
                label: event.friendlyLabel,
                status: 'running',
                isDelegation: event.name === DELEGATION_TOOL_NAME,
                startedAt: Date.now()
              }
            ]
          case 'tool_result':
            if (event.parentToolUseId) {
              return prev.map((item) =>
                item.kind === 'tool' && item.toolUseId === event.parentToolUseId
                  ? {
                      ...item,
                      substeps: item.substeps?.map((s) =>
                        s.toolUseId === event.toolUseId ? { ...s, status: event.ok ? ('ok' as const) : ('error' as const) } : s
                      )
                    }
                  : item
              )
            }
            return prev.map((item) =>
              item.kind === 'tool' && item.toolUseId === event.toolUseId
                ? { ...item, status: event.ok ? 'ok' : 'error', summary: event.summary }
                : item
            )
          case 'delegation_activity': {
            const target = [...prev]
              .map((item, idx) => ({ item, idx }))
              .reverse()
              .find(({ item }) => item.kind === 'tool' && item.isDelegation && item.status === 'running')?.idx
            if (target === undefined) return prev
            return prev.map((item, idx) => {
              if (idx !== target || item.kind !== 'tool') return item
              const steps = item.activity ?? []
              const at = steps.findIndex((s) => s.id === event.activity.id)
              const next = at === -1 ? [...steps, event.activity] : steps.map((s, i) => (i === at ? event.activity : s))
              return { ...item, activity: next.slice(-150) }
            })
          }
          case 'delegation_progress': {
            // Progress events aren't correlated to a toolUseId, so attach to
            // the most recent still-running delegation card.
            const lastRunningIndex = [...prev]
              .map((item, idx) => ({ item, idx }))
              .reverse()
              .find(({ item }) => item.kind === 'tool' && item.isDelegation && item.status === 'running')?.idx
            if (lastRunningIndex === undefined) return prev
            return prev.map((item, idx) =>
              idx === lastRunningIndex && item.kind === 'tool'
                ? { ...item, progressNote: event.note }
                : item
            )
          }
          case 'error':
            if (!isReplay) onError(event.message)
            return [...prev, { kind: 'error', message: event.message }]
          case 'task_progress':
            if (event.note === 'mcp_config_reloaded') {
              return [...prev, { kind: 'notice', text: 'Reloaded MCP tools from .mcp.json' }]
            }
            return prev
          case 'route':
            return [...prev, { kind: 'route', label: event.label, reason: event.reason, detail: event.detail }]
          case 'secret_leak':
            if (!isReplay) setLeaks(event.leaks)
            return prev
          case 'review_started':
            return [...prev, { kind: 'review', status: 'running' }]
          case 'review_result': {
            const result: ChatItem = {
              kind: 'review',
              status: event.ok ? 'done' : 'error',
              summary: event.summary,
              findings: event.findings,
              fixing: event.fixing
            }
            const runningIndex = prev.findLastIndex((item) => item.kind === 'review' && item.status === 'running')
            return runningIndex === -1
              ? [...prev, result]
              : prev.map((item, i) => (i === runningIndex ? result : item))
          }
          case 'usage':
            return [
              ...prev,
              {
                kind: 'usage',
                text: [
                  `${event.steps} step${event.steps === 1 ? '' : 's'}`,
                  `${compactCount(event.fresh)} new`,
                  `${compactCount(event.cached)} cached`,
                  `${compactCount(event.output)} written`
                ].join(' · ')
              }
            ]
          case 'plan_proposed':
            return [
              ...prev,
              { kind: 'plan', toolUseId: event.toolUseId, plan: event.plan, steps: event.steps, status: 'pending', progress: {}, by: event.by }
            ]
          case 'plan_finished': {
            const at = prev.findLastIndex((item) => item.kind === 'plan' && item.status === 'approved')
            if (at === -1) return prev
            const finished = { total: event.total, tracked: event.tracked, stopped: event.stopped }
            return prev.map((item, i) => (i === at && item.kind === 'plan' ? { ...item, finished } : item))
          }
          case 'deploy_result':
            return [
              ...prev,
              {
                kind: 'notice',
                text: event.ok
                  ? `🚀 Deployed with the Deploy button ("${event.name}", ${event.seconds}s).${event.detail ? ` ${event.detail}.` : ''}`
                  : `🚀 Deploy ${event.stopped ? 'stopped' : `failed at "${event.failedStep}"`}${event.rolledBack ? '; the previous version was put back' : ''}.${event.detail ? ` ${event.detail}` : ''}`
              }
            ]
          case 'deploy_recipe_ready':
            return [...prev, { kind: 'deploy_ready', name: event.name, steps: event.steps }]
          case 'scheduled_run': {
            const notice: ChatItem = { kind: 'notice', text: `⏰ Scheduled: "${event.name}" (${event.what})` }
            // Reopened, the request's own message follows from the history; live, it's added here.
            if (isReplay || !event.text) return [...prev, notice]
            setBusy(true)
            return [...prev, notice, { kind: 'user_text', text: event.text }]
          }
          case 'schedule_note':
          case 'github_note':
            return [...prev, { kind: 'notice', text: event.text }]
          case 'schedule_ready':
            return [...prev, { kind: 'schedule_ready', scheduleId: event.scheduleId, name: event.name, summary: event.summary }]
          case 'plan_suggested': {
            // Only meaningful at the moment it's asked; the question isn't repeated when the chat is reopened.
            if (isReplay) return prev
            setBusy(false)
            // The message will be added again by whichever answer is picked.
            const last = prev.findLastIndex((item) => item.kind === 'user_text' && item.text === event.text)
            const without = last === -1 ? prev : prev.filter((_, i) => i !== last)
            return [...without, { kind: 'plan_suggestion', text: event.text }]
          }
          case 'plan_decided':
            return prev.map((item) =>
              item.kind === 'plan' && item.toolUseId === event.toolUseId ? { ...item, status: event.decision } : item
            )
          case 'plan_progress': {
            const at = prev.findLastIndex((item) => item.kind === 'plan' && item.status === 'approved')
            if (at === -1) return prev
            return prev.map((item, i) =>
              i === at && item.kind === 'plan' ? { ...item, progress: { ...item.progress, [event.step]: event.status } } : item
            )
          }
          case 'compacting':
            return [
              ...prev,
              { kind: 'notice', text: 'Compacting the conversation to keep it fast…' }
            ]
          case 'session_compacted':
            // The real size (summary plus Claude's instructions) is known after the next message.
            if (!isReplay) {
              setContextTokens(0)
              // A fresh start: the size note may come back when it's big again.
              hideNote(null)
            }
            return [
              ...prev,
              {
                kind: 'notice',
                text: `Compacted the conversation: about ${compactCount(event.before)} tokens of history (with Claude's instructions) became a summary of about ${compactCount(event.after)}${
                  event.trigger === 'auto' ? ' (Claude Code did this on its own, near its limit; memory was saved first)' : ''
                }. The full history is still searchable.`
              }
            ]
          case 'session_rotated':
            return [
              ...prev,
              {
                kind: 'notice',
                text: `Started a fresh Claude session to keep things fast (the last one had grown to about ${compactCount(event.contextTokens)} tokens). Memory and a summary of the conversation carried over.`,
                details: event.summary
              }
            ]
          case 'claude_limit':
            return [
              ...prev,
              {
                kind: 'notice',
                text: `Claude's plan limit was reached${event.resetsAt ? ` (it resets at ${formatClock(event.resetsAt)})` : ''}.`
              }
            ]
          case 'takeover_started':
            if (!isReplay) setBusy(true)
            return [
              ...prev,
              {
                kind: 'notice',
                text: `Claude is out${event.resetsAt ? ` until ${formatClock(event.resetsAt)}` : ''}. Codex is handling this directly.`
              }
            ]
          case 'takeover_offer':
            if (isReplay) {
              return [...prev, { kind: 'notice', text: 'Claude is out. This request was waiting for you to let Codex handle it.' }]
            }
            setBusy(false)
            return [...prev, { kind: 'offer', text: event.text, resetsAt: event.resetsAt }]
          case 'stopped':
            // Stop also cancelled any open prompts or questions.
            if (!isReplay) setConfirmations([])
            return [...prev, { kind: 'notice', text: '⏹ Stopped.' }]
          case 'turn_complete':
            if (!isReplay) {
              setBusy(false)
              refreshHasChanges()
              setRefreshToken((t) => t + 1)
              window.vibe.chat.contextSize(project.id).then(setContextTokens).catch(() => undefined)
            }
            return prev
          default:
            return prev
        }
      })
    },
    [refreshHasChanges, onError, project.id, hideNote]
  )

  useEffect(() => {
    window.vibe.chat.contextSize(project.id).then(setContextTokens).catch(() => undefined)
    setNoteHiddenAt(readNoteHidden(project.id))
  }, [project.id])

  useEffect(() => {
    const apply = (s: { autoCompact: boolean; rotateAtTokens: number }): void =>
      setCompactAt({ auto: s.autoCompact, tokens: s.rotateAtTokens || 120_000 })
    window.vibe.settings.get().then(apply).catch(() => undefined)
    return window.vibe.settings.onChanged(apply)
  }, [])

  useEffect(() => {
    let cancelled = false
    // A long project's log runs to tens of thousands of entries (every Codex step is saved).
    // Only the recent requests are fetched and replayed, with a button for the rest: loading the
    // whole log made a big project slow to open, and a phone downloaded all of it every time.
    window.vibe.chat.loadRecent(project.id, showAllHistory ? 0 : REPLAY_REQUESTS).then(({ entries, earlier }) => {
      if (cancelled) return
      setItems(earlier > 0 ? [{ kind: 'older', hidden: earlier }] : [])
      for (const entry of entries) {
        if (entry.direction === 'user' && entry.text) {
          const item: ChatItem = {
            kind: 'user_text',
            text: entry.text,
            snapshot: entry.snapshot,
            attachment: entry.attachment,
            images: entry.images
          }
          setItems((prev) => [...prev, item])
        } else if (entry.direction === 'event' && entry.event) {
          applyEvent(entry.event, true)
        }
      }
      // A review with no result was cut off (the app closed mid-review).
      setItems((prev) =>
        prev.map((item) =>
          item.kind === 'review' && item.status === 'running'
            ? { kind: 'review', status: 'error', summary: 'Codex review was interrupted.' }
            : item
        )
      )
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, showAllHistory])

  useEffect(() => {
    const unsubEvent = window.vibe.chat.onEvent((projectId, event) => {
      if (projectId === project.id) applyEvent(event)
    })
    const addConfirmations = (requests: ConfirmationRequest[]): void =>
      setConfirmations((prev) => [...prev, ...requests.filter((r) => !prev.some((p) => p.id === r.id))])
    // Pick up any that arrived while this chat wasn't open.
    window.vibe.chat.pendingConfirmations(project.id).then(addConfirmations)
    const unsubConfirm = window.vibe.chat.onConfirmationRequest((projectId, request) => {
      if (projectId === project.id) addConfirmations([request])
    })
    return () => {
      unsubEvent()
      unsubConfirm()
    }
  }, [project.id, applyEvent])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items])

  const sendMessage = useCallback(
    async (
      text: string,
      element?: PickedElement,
      images: PendingImage[] = [],
      forceBuild = false,
      extra?: { mode?: 'build' | 'plan'; approvedPlan?: string; todoId?: string }
    ) => {
      // Plan mode (unless this is an answer to a plan, which says what it is itself).
      const sendExtra = extra ?? (mode === 'plan' && !forceBuild ? { mode: 'plan' as const } : undefined)
      const index = { value: -1 }
      setItems((prev) => {
        index.value = prev.length
        return [
          ...prev,
          {
            kind: 'user_text',
            text,
            attachment: element ? describePicked(element) : undefined,
            images: images.length ? images.map((img) => img.dataUrl) : undefined
          }
        ]
      })
      setBusy(true)
      setProblem(null)
      if (askMode && !forceBuild && !extra && !element && images.length === 0) {
        try {
          await window.vibe.chat.ask(project.id, project.path, text)
        } catch (err) {
          setBusy(false)
          onError(`Couldn't ask that: ${(err as Error).message}`)
        }
        return
      }
      try {
        const { snapshot, thumbnails } = await window.vibe.chat.send(
          project.id,
          project.path,
          text,
          element,
          images.map(toAttachment),
          forceBuild || !!sendExtra,
          sendExtra
        )
        // Swap the full-size local previews for the small saved thumbnails.
        setItems((prev) =>
          prev.map((item, i) =>
            i === index.value && item.kind === 'user_text'
              ? { ...item, snapshot, images: thumbnails.length ? thumbnails : item.images }
              : item
          )
        )
      } catch (err) {
        setBusy(false)
        onError(`Failed to send message: ${(err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
      }
    },
    [project, onError, askMode, mode]
  )

  // Moves this chat into a new Claude session seeded with a summary, so it stops re-reading everything.
  // Shrinks the conversation in place (after saving what only it knows).
  const handleCompact = useCallback(async () => {
    setRotating(true)
    setBusy(true)
    try {
      const result = await window.vibe.chat.compactNow(project.id, project.path)
      if (!result.ok) onError(result.message ?? "Couldn't compact the conversation.")
    } catch (err) {
      onError(`Couldn't compact the conversation: ${(err as Error).message}`)
    } finally {
      setRotating(false)
      setBusy(false)
    }
  }, [project.id, project.path, onError])

  const handleFreshSession = useCallback(async () => {
    if (
      hasChanges &&
      !window.confirm(
        "You have changes that aren't committed yet. A fresh session doesn't touch your files, but this is a good moment to press Checkpoint first. Continue anyway?"
      )
    ) {
      return
    }
    setRotating(true)
    try {
      const result = await window.vibe.chat.rotateNow(project.id, project.path)
      if (result.ok) setContextTokens(0)
      else onError(result.message ?? "Couldn't start a fresh session.")
    } catch (err) {
      onError(`Couldn't start a fresh session: ${(err as Error).message}`)
    } finally {
      setRotating(false)
    }
  }, [hasChanges, project.id, project.path, onError])

  const handleSend = useCallback(() => {
    const images = pendingImages
    const text = input.trim() || (images.length ? 'Take a look at this.' : '')
    if (!text || busy) return
    setInput('')
    setPendingImages([])
    const element = picked ?? undefined
    setPicked(null)
    // Keys pasted into the chat would be sent to the AI and saved in the
    // transcript; offer to keep them in Secrets instead.
    const found = detectSecrets(text)
    if (found.length) {
      setPendingSecret({ text, element, images, found: found.map((f) => ({ ...f, saveAs: f.name })) })
      return
    }
    sendMessage(text, element, images)
  }, [input, busy, picked, pendingImages, sendMessage])

  const addImageFiles = useCallback(
    async (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith('image/'))
      if (images.length === 0) return
      try {
        const read = await Promise.all(images.map(readImageFile))
        setPendingImages((prev) => [...prev, ...read].slice(0, 10))
      } catch (err) {
        onError((err as Error).message)
      }
    },
    [onError]
  )

  const handleStop = useCallback(async () => {
    setStopping(true)
    try {
      await window.vibe.chat.stop(project.id)
    } catch (err) {
      onError(`Couldn't stop: ${(err as Error).message}`)
      setStopping(false)
    }
  }, [project.id, onError])

  // Stopping ends when the turn does.
  useEffect(() => {
    if (!busy) setStopping(false)
  }, [busy])

  const handleSaveDetectedSecrets = useCallback(async () => {
    if (!pendingSecret) return
    let text = pendingSecret.text
    try {
      for (const secret of pendingSecret.found) {
        const saved = await window.vibe.secrets.set(project.id, secret.saveAs, secret.value)
        text = text.split(secret.value).join(`[${saved.name}, saved in VibeApp Secrets]`)
      }
    } catch (err) {
      onError((err as Error).message)
      return
    }
    setPendingSecret(null)
    sendMessage(text, pendingSecret.element, pendingSecret.images)
  }, [pendingSecret, project.id, sendMessage, onError])

  const handleFixLeaks = useCallback(
    (message: string) => {
      setDialog(null)
      setLeaks(null)
      sendMessage(message)
    },
    [sendMessage]
  )

  const handleRestore = useCallback(
    async (snapshot: string, kind: 'undo' | 'redo', fromText?: string) => {
      if (busy || restoring) return
      setRestoring(true)
      try {
        const { redoSnapshot, changedFiles } = await window.vibe.chat.undo(project.path, snapshot, project.id, kind, fromText)
        const n = changedFiles.length
        const files = `${n} file${n === 1 ? '' : 's'}`
        const item: ChatItem =
          n === 0
            ? { kind: 'restore', text: 'Nothing to undo: no files have changed since then.' }
            : kind === 'undo'
              ? {
                  kind: 'restore',
                  text: `Undid changes to ${files}${fromText ? ` (back to before “${fromText.slice(0, 60)}${fromText.length > 60 ? '…' : ''}”)` : ''}.`,
                  restoreTo: redoSnapshot,
                  actionLabel: 'Redo'
                }
              : { kind: 'restore', text: `Redid changes to ${files}.`, restoreTo: redoSnapshot, actionLabel: 'Undo' }
        setItems((prev) => [...prev, item])
        refreshHasChanges()
        setRefreshToken((t) => t + 1)
      } catch (err) {
        onError(`Couldn't undo: ${(err as Error).message}`)
      } finally {
        setRestoring(false)
      }
    },
    [busy, restoring, project.path, refreshHasChanges, onError]
  )

  // Problems that show up while Claude is mid-edit are usually half-written
  // files; only surface ones that appear once it's done.
  const handleProblem = useCallback((next: PreviewProblem) => {
    if (busyRef.current || dismissedProblems.current.has(next.message)) return
    setProblem(next)
    setProblemExpanded(false)
  }, [])

  const handleFixProblem = useCallback(() => {
    if (!problem || busy) return
    const where = problem.source === 'page' ? 'Error in the page' : 'Output from the app’s server'
    sendMessage(
      `Something broke in the app preview. Please find the cause and fix it.\n\n${where}:\n${problem.message.slice(0, 4000)}`
    )
  }, [problem, busy, sendMessage])

  const dismissProblem = useCallback(() => {
    if (problem) dismissedProblems.current.add(problem.message)
    setProblem(null)
  }, [problem])

  const handlePicked = useCallback((element: PickedElement) => {
    setPicked(element)
    // On a phone the chat is a separate pane: go back to it to type what should change.
    setPhonePane('chat')
    inputRef.current?.focus()
  }, [])

  const handleConfirmation = useCallback(
    (approved: boolean, answers?: QuestionAnswers) => {
      if (!confirmation) return
      window.vibe.chat.respondToConfirmation(project.id, confirmation.id, approved, answers)
      setConfirmations((prev) => prev.filter((c) => c.id !== confirmation.id))
      if (answers) {
        const text = Object.entries(answers)
          .map(([question, answer]) => `${question} → ${answer}`)
          .join('\n')
        setItems((prev) => [...prev, { kind: 'user_text', text }])
      }
    },
    [confirmation, project.id]
  )

  const handleCheckpoint = useCallback(
    async (message: string) => {
      await window.vibe.git.checkpoint(project.path, message)
      refreshHasChanges()
    },
    [project.path, refreshHasChanges]
  )

  const suggestMessage = useCallback(
    () => window.vibe.git.suggestMessage(project.path),
    [project.path]
  )

  return (
    <div className="chat-view">
      <div className="chat-header">
        <button onClick={onBack}>&larr; Projects</button>
        <span className="chat-project-name">{project.name}</span>
        <div className="chat-header-actions" data-scroll-x>
          <button className={showPreview && sidePane === 'preview' ? 'active' : ''} onClick={() => toggleSide('preview')}>
            Preview
          </button>
          <button
            className={showPreview && sidePane === 'notes' ? 'active' : ''}
            onClick={() => toggleSide('notes')}
            title="This project's to-do list and notes"
          >
            📝 Notes
          </button>
          <button onClick={() => setDialog('secrets')} title="API keys and passwords for this project">
            🔑 Secrets
          </button>
          <button onClick={() => setDialog('publish')} disabled={busy}>
            Publish
          </button>
          <button onClick={() => setDialog('deploy')} title="Put this project live with its own deploy steps, with no AI">
            🚀 Deploy
          </button>
          <button
            onClick={() => {
              setScheduleFocus(undefined)
              setDialog('schedules')
            }}
            title="Run requests, the next to-do, Deploy or a site check on a schedule"
          >
            ⏰ Schedules
          </button>
          <button onClick={onOpenHistory}>History</button>
          <CheckpointButton
            hasChanges={hasChanges}
            onCheckpoint={handleCheckpoint}
            suggestMessage={suggestMessage}
          />
          <GoNutzToggle enabled={goNutz} onChange={handleGoNutzChange} />
        </div>
      </div>

      {goNutz && (
        <div className="go-nutz-banner">
          🔥 Go Nutz mode is ON for this project — no confirmation prompts, no sandbox.
        </div>
      )}

      <GitHubSyncBanner project={project} busy={busy} onAskClaude={(text) => void sendMessage(text)} onError={onError} />


      {phone && (
        <div className="mobile-pane-switch chat-mode-switch" role="tablist" aria-label="Show">
          <button
            role="tab"
            aria-selected={phonePane === 'chat' || !showPreview}
            className={phonePane === 'chat' || !showPreview ? 'active' : ''}
            onClick={() => setPhonePane('chat')}
          >
            💬 Chat
          </button>
          {(['preview', 'notes'] as const).map((pane) => {
            const on = showPreview && phonePane === 'preview' && sidePane === pane
            return (
              <button
                key={pane}
                role="tab"
                aria-selected={on}
                className={on ? 'active' : ''}
                onClick={() => {
                  setSidePane(pane)
                  setSideOpen(true)
                  setPhonePane('preview')
                }}
              >
                {pane === 'preview' ? '👁 Preview' : '📝 Notes'}
              </button>
            )
          })}
        </div>
      )}

      <div className={`chat-body${showPreview ? ' with-preview' : ''}${phone ? ` phone-pane-${showPreview ? phonePane : 'chat'}` : ''}`}>
        <div
          className={`chat-main${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return
            e.preventDefault()
            setDragging(false)
            addImageFiles([...e.dataTransfer.files])
          }}
        >
          <div className="chat-log" ref={scrollRef}>
            {items.map((item, i) => (
              <div key={i} className={`chat-item chat-item-${item.kind}`}>
                {item.kind === 'user_text' && (
                  <>
                    {item.attachment && <span className="chat-attachment">📍 {item.attachment}</span>}
                    {item.images && item.images.length > 0 && (
                      <div className="chat-images">
                        {item.images.map((src, j) =>
                          src ? <img key={j} src={src} alt="" /> : <span key={j} className="chat-image-missing">🖼</span>
                        )}
                      </div>
                    )}
                    <p>{item.text}</p>
                    {item.snapshot && (
                      <button
                        className="chat-undo"
                        onClick={() => handleRestore(item.snapshot!, 'undo', item.text)}
                        disabled={busy || restoring}
                        title="Put your files back the way they were before this message"
                      >
                        ↩ Undo
                      </button>
                    )}
                  </>
                )}
                {item.kind === 'assistant_text' && <Markdown text={item.text} />}
                {item.kind === 'tool' && (
                  <div
                    className={`tool-card tool-card-${item.status} ${item.isDelegation ? 'tool-card-delegation' : ''}`}
                  >
                    <span className="tool-card-label" title={item.label}>
                      {shortenProjectPaths(item.label, project.path)}
                    </span>
                    {item.status === 'running' && (
                      <span className="tool-status">{item.progressNote ?? 'working…'}</span>
                    )}
                    {item.status === 'error' && <span className="tool-status">failed</span>}
                  </div>
                )}
                {item.kind === 'tool' && !!item.substeps?.length && (
                  <details className="substeps" open={item.status === 'running'}>
                    <summary>
                      {item.substeps.length} step{item.substeps.length === 1 ? '' : 's'} by this helper
                    </summary>
                    <ul>
                      {item.substeps.map((s) => (
                        <li key={s.toolUseId} className={`substep-${s.status}`}>
                          {s.status === 'ok' ? '✓' : s.status === 'error' ? '✗' : '…'}{' '}
                          {shortenProjectPaths(s.label, project.path)}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {item.kind === 'tool' && item.isDelegation && (
                  <CodexFeed
                    steps={item.activity ?? []}
                    running={item.status === 'running'}
                    startedAt={item.startedAt}
                    projectPath={project.path}
                  />
                )}
                {item.kind === 'error' && <p className="chat-error">{item.message}</p>}
                {item.kind === 'plan' && (
                  <PlanCard
                    plan={item.plan}
                    steps={item.steps}
                    status={item.status}
                    progress={item.progress}
                    by={item.by}
                    finished={item.finished}
                    busy={busy}
                    onApprove={() => {
                      void window.vibe.chat.planDecided(project.id, item.toolUseId, 'approved')
                      const todoId = planTodo.current ?? undefined
                      planTodo.current = null
                      sendMessage('✅ Approved the plan. Go ahead and build it.', undefined, [], true, { approvedPlan: item.plan, todoId })
                    }}
                    onRevise={(feedback) => {
                      void window.vibe.chat.planDecided(project.id, item.toolUseId, 'revised')
                      sendMessage(`Change the plan: ${feedback}`, undefined, [], true, { mode: 'plan' })
                    }}
                    onCancel={() => {
                      planTodo.current = null
                      void window.vibe.chat.planDecided(project.id, item.toolUseId, 'cancelled')
                    }}
                  />
                )}
                {item.kind === 'plan_suggestion' && (
                  <div className="plan-suggestion">
                    <p>
                      📋 <strong>This looks like a big request. Plan it first?</strong> Claude will look around and show you
                      a plan to approve before anything changes.
                    </p>
                    <p className="plan-suggestion-text">“{item.text.length > 220 ? `${item.text.slice(0, 220)}…` : item.text}”</p>
                    <div className="plan-actions">
                      <button
                        className="plan-approve"
                        disabled={busy || item.used}
                        onClick={() => {
                          setItems((prev) => prev.map((it, idx) => (idx === i && it.kind === 'plan_suggestion' ? { ...it, used: true } : it)))
                          sendMessage(item.text, undefined, [], true, { mode: 'plan' })
                        }}
                      >
                        📋 Plan it
                      </button>
                      <button
                        disabled={busy || item.used}
                        onClick={() => {
                          setItems((prev) => prev.map((it, idx) => (idx === i && it.kind === 'plan_suggestion' ? { ...it, used: true } : it)))
                          sendMessage(item.text, undefined, [], true)
                        }}
                      >
                        🔨 Just build
                      </button>
                    </div>
                    <small className="settings-hint">You can change this in Settings (big requests).</small>
                  </div>
                )}
                {item.kind === 'older' && (
                  <button className="chat-inline-action" disabled={busy} onClick={() => setShowAllHistory(true)}>
                    Show {item.hidden} earlier request{item.hidden === 1 ? '' : 's'}
                  </button>
                )}
                {item.kind === 'deploy_ready' && (
                  <div className="plan-suggestion">
                    <p>
                      🚀 <strong>Deploy steps ready: {item.name}</strong> ({item.steps} step{item.steps === 1 ? '' : 's'}). Check them
                      once; after that the Deploy button runs them with no AI.
                    </p>
                    <div className="plan-actions">
                      <button className="plan-approve" onClick={() => setDialog('deploy')}>
                        Check the Deploy steps
                      </button>
                    </div>
                  </div>
                )}
                {item.kind === 'schedule_ready' && (
                  <div className="plan-suggestion">
                    <p>
                      ⏰ <strong>Schedule ready: {item.name}</strong> ({item.summary}). Check it and turn it on; until then it does
                      nothing.
                    </p>
                    <div className="plan-actions">
                      <button
                        className="plan-approve"
                        onClick={() => {
                          setScheduleFocus(item.scheduleId)
                          setDialog('schedules')
                        }}
                      >
                        Check the schedule
                      </button>
                    </div>
                  </div>
                )}
                {item.kind === 'notice' && (
                  <>
                    <p className="chat-notice">{item.text}</p>
                    {item.details && (
                      <details className="chat-notice-details">
                        <summary>What carried over (check it, and tell Claude if something is missing)</summary>
                        <p style={{ whiteSpace: 'pre-wrap' }}>{item.details}</p>
                      </details>
                    )}
                  </>
                )}
                {item.kind === 'offer' && (
                  <div className="review-card review-card-running">
                    <div className="review-card-header">
                      <span>
                        Claude is out{item.resetsAt ? ` until ${formatClock(item.resetsAt)}` : ''}. Let Codex handle this request?
                      </span>
                      <button
                        className="chat-inline-action"
                        disabled={item.used || busy}
                        onClick={() => {
                          setItems((prev) => prev.map((it, idx) => (idx === i && it.kind === 'offer' ? { ...it, used: true } : it)))
                          setBusy(true)
                          window.vibe.chat.takeover(project.id, project.path).catch(() => setBusy(false))
                        }}
                      >
                        {item.used ? 'Sent to Codex' : 'Let Codex do it'}
                      </button>
                    </div>
                  </div>
                )}
                {item.kind === 'usage' && (
                  <span
                    className="chat-usage"
                    title="What this step of the request used. New = text Claude had to process fresh; cached = reused from earlier steps (cheap); written = what Claude wrote."
                  >
                    {item.text}
                  </span>
                )}
                {item.kind === 'route' && (
                  <span
                    className="chat-route"
                    title={[item.detail, 'Smart model switching (change it in Settings)'].filter(Boolean).join('\n')}
                  >
                    ⚡ {item.label} · {item.reason}
                  </span>
                )}
                {item.kind === 'route' && item.label === 'Answered as a question' && !busy && (
                  <button
                    className="chat-inline-action"
                    title="Send this message to Claude as a normal build request instead"
                    onClick={() => {
                      const asked = [...items.slice(0, i)].reverse().find((it) => it.kind === 'user_text')
                      if (asked && asked.kind === 'user_text') sendMessage(asked.text, undefined, [], true)
                    }}
                  >
                    Do it in Build instead
                  </button>
                )}
                {item.kind === 'review' && (
                  <div className={`review-card review-card-${item.status}`}>
                    {item.status === 'running' && (
                      <div className="review-card-header">
                        <span>🔍 Codex is double-checking Claude’s changes…</span>
                        <button className="chat-inline-action" onClick={() => window.vibe.chat.skipReview(project.id)}>
                          Skip review
                        </button>
                      </div>
                    )}
                    {item.status === 'error' && <span className="review-muted">{item.summary}</span>}
                    {item.status === 'done' && (
                      <>
                        <div className="review-card-header">
                          <span>
                            {item.findings?.length
                              ? `🔍 Codex found ${item.findings.length} issue${item.findings.length === 1 ? '' : 's'}${item.fixing ? ' — Claude is fixing them' : ''}`
                              : '✅ Codex double-checked the changes'}
                          </span>
                        </div>
                        {item.summary && <p className="review-summary">{item.summary}</p>}
                        {!!item.findings?.length && (
                          <details>
                            <summary>Details</summary>
                            <ul className="review-findings">
                              {item.findings.map((f, j) => (
                                <li key={j}>
                                  <span className={`review-severity review-severity-${f.severity}`}>{f.severity}</span>
                                  <strong>{f.title}</strong>
                                  <span className="review-muted">
                                    {' '}
                                    {f.file}
                                    {f.line ? `:${f.line}` : ''}
                                  </span>
                                  <div className="review-muted">{f.detail}</div>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </>
                    )}
                  </div>
                )}
                {item.kind === 'restore' && (
                  <p className="chat-notice">
                    {item.text}
                    {item.restoreTo && (
                      <button
                        className="chat-inline-action"
                        onClick={() => handleRestore(item.restoreTo!, item.actionLabel === 'Redo' ? 'redo' : 'undo')}
                        disabled={busy || restoring}
                      >
                        {item.actionLabel}
                      </button>
                    )}
                  </p>
                )}
              </div>
            ))}
            {busy && <div className="chat-item chat-item-thinking">{thinkingLabel}</div>}
          </div>

          {leaks && !busy && (
            <div className="problem-banner">
              <div className="problem-banner-header">
                <span>🔑 A secret key was written into your project files.</span>
                <div className="confirmation-actions">
                  <button
                    onClick={() =>
                      handleFixLeaks(
                        `A secret key ended up in project files:\n${leaks
                          .slice(0, 20)
                          .map((l) => `- ${l.file}:${l.line} (${l.what})`)
                          .join('\n')}\nMove it out: read it from an environment variable instead and delete the value from the file. If it isn't in VibeApp's Secrets panel yet, tell me the name to add.`
                      )
                    }
                  >
                    Fix it
                  </button>
                  <button onClick={() => setLeaks(null)}>Dismiss</button>
                </div>
              </div>
              <pre>{leaks.slice(0, 5).map((l) => `${l.file}:${l.line} (${l.what})`).join('\n')}</pre>
            </div>
          )}

          {problem && !busy && (
            <div className="problem-banner">
              <div className="problem-banner-header">
                <span>⚠️ Something broke in your app.</span>
                <div className="confirmation-actions">
                  <button onClick={handleFixProblem}>Fix it</button>
                  <button onClick={() => setProblemExpanded(!problemExpanded)}>
                    {problemExpanded ? 'Hide' : 'Details'}
                  </button>
                  <button onClick={dismissProblem}>Dismiss</button>
                </div>
              </div>
              <pre className={problemExpanded ? 'expanded' : ''}>{problem.message}</pre>
            </div>
          )}

          {confirmation?.questions?.length ? (
            <QuestionCard
              key={confirmation.id}
              questions={confirmation.questions}
              onAnswer={(answers) => handleConfirmation(true, answers)}
              onSkip={() => handleConfirmation(false)}
            />
          ) : confirmation && (
            <div className="confirmation-banner">
              <span>{confirmation.reason} Allow it?</span>
              <div className="confirmation-actions">
                <button onClick={() => handleConfirmation(true)}>Allow</button>
                <button onClick={() => handleConfirmation(false)}>Deny</button>
              </div>
            </div>
          )}

          {picked && (
            <div className="picked-chip">
              <span>📍 {describePicked(picked)}</span>
              <button onClick={() => setPicked(null)} title="Remove">
                ✕
              </button>
            </div>
          )}

          {pendingImages.length > 0 && (
            <div className="pending-images">
              {pendingImages.map((img, i) => (
                <div key={i} className="pending-image" title={img.name}>
                  <img src={img.dataUrl} alt={img.name} />
                  <button onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))} title="Remove">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {!askMode &&
            !busy &&
            contextTokens >= noteThreshold() &&
            !(noteHiddenAt && contextTokens < noteHiddenAt + NOTE_RETURNS_AFTER) && (
            <div className="chat-cost-note">
              <span>
                💡 This chat has grown to about {compactCount(contextTokens)} tokens, and every Build message re-reads
                it. Compacting shrinks it in place (rules, procedures and the project brief are saved first); questions
                are cheaper still in Ask mode.
              </span>
              <button className="chat-inline-action" disabled={rotating} onClick={handleCompact}>
                {rotating ? 'Working…' : 'Compact now'}
              </button>
              <button className="chat-inline-action" onClick={() => setMode('ask')}>
                Switch to Ask
              </button>
              <button className="chat-inline-action" disabled={rotating} onClick={handleFreshSession}>
                {rotating ? 'Starting…' : 'Start a fresh session'}
              </button>
              <button
                className="chat-inline-action chat-cost-note-hide"
                title="Hide this until the chat grows a lot more (the meter by Build / Plan / Ask keeps showing the size)"
                aria-label="Hide this note"
                onClick={() => hideNote(contextTokens)}
              >
                ✕
              </button>
            </div>
          )}

          <div className="chat-compose-bar">
          <div className="chat-mode-switch" role="group" aria-label="Message type">
            <button
              className={mode === 'build' ? 'active' : ''}
              disabled={busy}
              title="Build: Claude and Codex work on your project"
              onClick={() => setMode('build')}
            >
              🔨 Build
            </button>
            <button
              className={mode === 'plan' ? 'active' : ''}
              disabled={busy}
              title="Plan: Claude looks around and proposes a plan; nothing changes until you approve it"
              onClick={() => setMode('plan')}
            >
              📋 Plan
            </button>
            <button
              className={mode === 'ask' ? 'active' : ''}
              disabled={busy}
              title="Ask: get an answer about your project without changing any files"
              onClick={() => setMode('ask')}
            >
              💬 Ask
            </button>
          </div>
          <ContextMeter
            tokens={contextTokens}
            limit={compactAt.auto ? compactAt.tokens : CLAUDE_CONTEXT_LIMIT}
            auto={compactAt.auto}
          />
          <button
            className="chat-compact"
            disabled={busy || rotating || contextTokens === 0}
            title="Compact now: shrink this chat to a summary (rules, procedures and the project brief are saved first), so each Build message re-reads less"
            onClick={handleCompact}
          >
            {rotating ? '…' : '🗜'} <span className="chat-compact-label">Compact</span>
          </button>
          </div>

          <div className="chat-input-row">
            <button
              className="chat-attach"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              title="Attach images (you can also paste or drag them in)"
            >
              📎
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                addImageFiles([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
            <textarea
              ref={inputRef}
              className="chat-input"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
                if (files.length) {
                  e.preventDefault()
                  addImageFiles(files)
                }
              }}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter is a new line. Enter that confirms
                // an IME composition (e.g. Japanese input) does neither.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              placeholder={
                askMode
                  ? 'Ask a question about your project…'
                  : mode === 'plan'
                  ? 'What do you want to build? Claude will plan it first…'
                  : picked
                  ? 'What should change about this?'
                  : pendingImages.length
                    ? 'What should Claude do with this?'
                    : 'Tell VibeApp what to build…'
              }
              title="Enter to send · Shift+Enter for a new line · paste or drop images · drag the edge to resize"
              disabled={busy}
            />
            {busy ? (
              <button
                className="chat-stop"
                onClick={handleStop}
                disabled={stopping}
                title="Stop Claude (and any Codex work) right now"
              >
                {stopping ? 'Stopping…' : '■ Stop'}
              </button>
            ) : (
              <button onClick={handleSend} disabled={!input.trim() && pendingImages.length === 0}>
                Send
              </button>
            )}
          </div>
        </div>

        {showPreview && (
          // Kept running behind the Notes tab, so switching back doesn't reload the app.
          <div style={{ display: sidePane === 'preview' ? 'contents' : 'none' }}>
            <PreviewPane
              projectId={project.id}
              projectPath={project.path}
              refreshToken={refreshToken}
              picking={picking}
              onPickingChange={setPicking}
              onPicked={handlePicked}
              onProblem={handleProblem}
            />
          </div>
        )}
        {showPreview && sidePane === 'notes' && (
          <NotesPane
            projectId={project.id}
            busy={busy}
            onBuild={(todo, plan) => {
              if (phone) setPhonePane('chat')
              if (plan) {
                planTodo.current = todo.id
                sendMessage(todo.text, undefined, [], true, { mode: 'plan' })
              } else {
                planTodo.current = null
                sendMessage(todo.text, undefined, [], true, { todoId: todo.id })
              }
            }}
            onOpenSecrets={() => setDialog('secrets')}
            onError={onError}
          />
        )}
      </div>

      {dialog === 'secrets' && (
        <SecretsDialog projectId={project.id} onClose={() => setDialog(null)} onError={onError} />
      )}
      {dialog === 'deploy' && (
        <DeployDialog
          project={project}
          busy={busy}
          onClose={() => setDialog(null)}
          onError={onError}
          onAskClaude={(text) => {
            setMode('build')
            if (phone) setPhonePane('chat')
            sendMessage(text, undefined, [], true)
          }}
        />
      )}
      {dialog === 'schedules' && (
        <ScheduleDialog project={project} focusId={scheduleFocus} onClose={() => setDialog(null)} onError={onError} />
      )}
      {dialog === 'publish' && (
        <PublishDialog project={project} onClose={() => setDialog(null)} onError={onError} onFixLeaks={handleFixLeaks} />
      )}
      {pendingSecret && (
        <Modal
          title="That looks like a secret key"
          onClose={() => {
            // Cancelled: put the message back so nothing is lost.
            setInput(pendingSecret.text)
            if (pendingSecret.element) setPicked(pendingSecret.element)
            setPendingImages(pendingSecret.images)
            setPendingSecret(null)
          }}
        >
          <p className="modal-text">
            Anything sent in the chat goes to the AI and is saved in this project’s chat history. Save{' '}
            {pendingSecret.found.length === 1 ? 'it' : 'them'} in Secrets instead? Your app will still get{' '}
            {pendingSecret.found.length === 1 ? 'it' : 'them'} as {pendingSecret.found.length === 1 ? 'an environment variable' : 'environment variables'}.
          </p>
          {pendingSecret.found.map((secret, i) => (
            <label key={secret.value} className="secret-detected">
              <span>
                {secret.label} <span className="modal-muted">…{secret.value.slice(-4)}</span>
              </span>
              <input
                value={secret.saveAs}
                spellCheck={false}
                onChange={(e) => {
                  const saveAs = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
                  setPendingSecret((prev) =>
                    prev ? { ...prev, found: prev.found.map((f, j) => (j === i ? { ...f, saveAs } : f)) } : prev
                  )
                }}
              />
            </label>
          ))}
          <div className="modal-actions">
            <button
              onClick={() => {
                const { text, element, images } = pendingSecret
                setPendingSecret(null)
                sendMessage(text, element, images)
              }}
            >
              Send it anyway
            </button>
            <button className="modal-primary" onClick={handleSaveDetectedSecrets}>
              Save as secret &amp; send without it
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

/** How full this chat's conversation is, against where it will be compacted. */
function ContextMeter({ tokens, limit, auto }: { tokens: number; limit: number; auto: boolean }) {
  const share = limit > 0 ? Math.min(1, tokens / limit) : 0
  const level = share >= 0.9 ? 'high' : share >= 0.7 ? 'mid' : 'low'
  const title = tokens
    ? `This chat is about ${compactCount(tokens)} tokens; every Build step re-reads it. ${
        auto
          ? `It's compacted automatically at ${compactCount(limit)} (Settings).`
          : `Auto-compact is off, so Claude Code shrinks it itself near about ${compactCount(limit)}.`
      }`
    : 'The size is measured after the next message.'
  return (
    <div className={`context-meter context-meter-${level}`} title={title} aria-label={title}>
      <div className="context-meter-bar">
        <span style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <span className="context-meter-label">{tokens ? `${compactCount(tokens)} / ${compactCount(limit)}` : '–'}</span>
      <span className="context-meter-percent">{tokens ? `${Math.round(share * 100)}%` : '–'}</span>
    </div>
  )
}

export default ChatView
