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
import SecretsDialog from '../components/SecretsDialog'
import PublishDialog from '../components/PublishDialog'
import Modal from '../components/Modal'
import QuestionCard from '../components/QuestionCard'
import { shortenProjectPaths } from '../lib/labels'
import CodexFeed from '../components/CodexFeed'
import Markdown from '../components/Markdown'
import { detectSecrets, type DetectedSecret } from '@shared/secretPatterns'

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
      startedAt?: number
    }
  | { kind: 'error'; message: string }
  | { kind: 'notice'; text: string }
  | { kind: 'route'; label: string; reason: string; detail?: string }
  | { kind: 'restore'; text: string; restoreTo?: string; actionLabel?: string }
  | { kind: 'usage'; text: string }
  | {
      kind: 'review'
      status: 'running' | 'done' | 'error'
      summary?: string
      findings?: ReviewFinding[]
      fixing?: boolean
    }

const DELEGATION_TOOL_NAME = 'mcp__vibe_tools__run_codex_subtask'
const PREVIEW_PREF_KEY = 'vibeapp.showPreview'

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
  const [showPreview, setShowPreview] = useState(readPreviewPref)
  const [refreshToken, setRefreshToken] = useState(0)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<PickedElement | null>(null)
  const [problem, setProblem] = useState<PreviewProblem | null>(null)
  const [problemExpanded, setProblemExpanded] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [dialog, setDialog] = useState<'secrets' | 'publish' | null>(null)
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

  const togglePreview = useCallback(() => {
    setShowPreview((prev) => {
      try {
        localStorage.setItem(PREVIEW_PREF_KEY, String(!prev))
      } catch {
        // Only a remembered preference; fine to lose.
      }
      return !prev
    })
  }, [])

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
          case 'session_rotated':
            return [
              ...prev,
              {
                kind: 'notice',
                text: `Started a fresh Claude session to keep things fast (the last one had grown to about ${compactCount(event.contextTokens)} tokens). Memory and a summary of the conversation carried over.`
              }
            ]
          case 'stopped':
            // Stop also cancelled any open prompts or questions.
            if (!isReplay) setConfirmations([])
            return [...prev, { kind: 'notice', text: '⏹ Stopped.' }]
          case 'turn_complete':
            if (!isReplay) {
              setBusy(false)
              refreshHasChanges()
              setRefreshToken((t) => t + 1)
            }
            return prev
          default:
            return prev
        }
      })
    },
    [refreshHasChanges, onError]
  )

  useEffect(() => {
    let cancelled = false
    window.vibe.chat.loadTranscript(project.id).then((entries) => {
      if (cancelled) return
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
  }, [project.id])

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
    async (text: string, element?: PickedElement, images: PendingImage[] = []) => {
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
      try {
        const { snapshot, thumbnails } = await window.vibe.chat.send(
          project.id,
          project.path,
          text,
          element,
          images.map(toAttachment)
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
    [project, onError]
  )

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
        const { redoSnapshot, changedFiles } = await window.vibe.chat.undo(project.path, snapshot)
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
        <div className="chat-header-actions">
          <button className={showPreview ? 'active' : ''} onClick={togglePreview}>
            Preview
          </button>
          <button onClick={() => setDialog('secrets')} title="API keys and passwords for this project">
            🔑 Secrets
          </button>
          <button onClick={() => setDialog('publish')} disabled={busy}>
            Publish
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

      <div className={`chat-body${showPreview ? ' with-preview' : ''}`}>
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
                {item.kind === 'tool' && item.isDelegation && (
                  <CodexFeed
                    steps={item.activity ?? []}
                    running={item.status === 'running'}
                    startedAt={item.startedAt}
                    projectPath={project.path}
                  />
                )}
                {item.kind === 'error' && <p className="chat-error">{item.message}</p>}
                {item.kind === 'notice' && <p className="chat-notice">{item.text}</p>}
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
                picked
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
          <PreviewPane
            projectId={project.id}
            projectPath={project.path}
            refreshToken={refreshToken}
            picking={picking}
            onPickingChange={setPicking}
            onPicked={handlePicked}
            onProblem={handleProblem}
          />
        )}
      </div>

      {dialog === 'secrets' && (
        <SecretsDialog projectId={project.id} onClose={() => setDialog(null)} onError={onError} />
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

export default ChatView
