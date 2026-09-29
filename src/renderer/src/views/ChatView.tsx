import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ConfirmationRequest,
  PickedElement,
  PreviewProblem,
  ProjectRecord,
  VibeEvent
} from '@shared/types'
import CheckpointButton from '../components/CheckpointButton'
import GoNutzToggle from '../components/GoNutzToggle'
import PreviewPane from '../components/PreviewPane'

interface ChatViewProps {
  project: ProjectRecord
  onBack: () => void
  onOpenHistory: () => void
  onError: (message: string) => void
  thinkingLabel: string
}

type ChatItem =
  | { kind: 'user_text'; text: string; snapshot?: string; attachment?: string }
  | { kind: 'assistant_text'; text: string }
  | {
      kind: 'tool'
      toolUseId: string
      label: string
      status: 'running' | 'ok' | 'error'
      summary?: string
      isDelegation: boolean
      progressNote?: string
    }
  | { kind: 'error'; message: string }
  | { kind: 'notice'; text: string }
  | { kind: 'route'; label: string; reason: string }
  | { kind: 'restore'; text: string; restoreTo?: string; actionLabel?: string }

const DELEGATION_TOOL_NAME = 'mcp__vibe_tools__run_codex_subtask'
const PREVIEW_PREF_KEY = 'vibeapp.showPreview'

function describePicked(picked: PickedElement): string {
  const text = picked.text.trim().replace(/\s+/g, ' ').slice(0, 40)
  return `<${picked.tag}>${text ? ` "${text}"` : ''}`
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
  const busyRef = useRef(false)
  busyRef.current = busy
  const dismissedProblems = useRef(new Set<string>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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
                isDelegation: event.name === DELEGATION_TOOL_NAME
              }
            ]
          case 'tool_result':
            return prev.map((item) =>
              item.kind === 'tool' && item.toolUseId === event.toolUseId
                ? { ...item, status: event.ok ? 'ok' : 'error', summary: event.summary }
                : item
            )
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
            return [...prev, { kind: 'route', label: event.label, reason: event.reason }]
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
            attachment: entry.attachment
          }
          setItems((prev) => [...prev, item])
        } else if (entry.direction === 'event' && entry.event) {
          applyEvent(entry.event, true)
        }
      }
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
    async (text: string, element?: PickedElement) => {
      const index = { value: -1 }
      setItems((prev) => {
        index.value = prev.length
        return [
          ...prev,
          { kind: 'user_text', text, attachment: element ? describePicked(element) : undefined }
        ]
      })
      setBusy(true)
      setProblem(null)
      try {
        const { snapshot } = await window.vibe.chat.send(project.id, project.path, text, element)
        if (snapshot) {
          setItems((prev) =>
            prev.map((item, i) => (i === index.value && item.kind === 'user_text' ? { ...item, snapshot } : item))
          )
        }
      } catch (err) {
        setBusy(false)
        onError(`Failed to send message: ${(err as Error).message}`)
      }
    },
    [project, onError]
  )

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    const element = picked ?? undefined
    setPicked(null)
    sendMessage(text, element)
  }, [input, busy, picked, sendMessage])

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
    (approved: boolean) => {
      if (!confirmation) return
      window.vibe.chat.respondToConfirmation(project.id, confirmation.id, approved)
      setConfirmations((prev) => prev.filter((c) => c.id !== confirmation.id))
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
        <div className="chat-main">
          <div className="chat-log" ref={scrollRef}>
            {items.map((item, i) => (
              <div key={i} className={`chat-item chat-item-${item.kind}`}>
                {item.kind === 'user_text' && (
                  <>
                    {item.attachment && <span className="chat-attachment">📍 {item.attachment}</span>}
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
                {item.kind === 'assistant_text' && <p>{item.text}</p>}
                {item.kind === 'tool' && (
                  <div
                    className={`tool-card tool-card-${item.status} ${item.isDelegation ? 'tool-card-delegation' : ''}`}
                  >
                    <span>{item.label}</span>
                    {item.status === 'running' && (
                      <span className="tool-status">{item.progressNote ?? 'working…'}</span>
                    )}
                    {item.status === 'error' && <span className="tool-status">failed</span>}
                  </div>
                )}
                {item.kind === 'error' && <p className="chat-error">{item.message}</p>}
                {item.kind === 'notice' && <p className="chat-notice">{item.text}</p>}
                {item.kind === 'route' && (
                  <span className="chat-route" title="Smart model switching (change it in Settings)">
                    ⚡ {item.label} · {item.reason}
                  </span>
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

          {confirmation && (
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

          <div className="chat-input-row">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              placeholder={picked ? 'What should change about this?' : 'Tell VibeApp what to build…'}
              disabled={busy}
            />
            <button onClick={handleSend} disabled={busy || !input.trim()}>
              Send
            </button>
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
    </div>
  )
}

export default ChatView
