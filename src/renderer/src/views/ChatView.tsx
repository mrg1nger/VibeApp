import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConfirmationRequest, ProjectRecord, VibeEvent } from '@shared/types'
import CheckpointButton from '../components/CheckpointButton'

interface ChatViewProps {
  project: ProjectRecord
  onBack: () => void
  onOpenHistory: () => void
  onError: (message: string) => void
}

type ChatItem =
  | { kind: 'user_text'; text: string }
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

const DELEGATION_TOOL_NAME = 'mcp__vibe_tools__run_codex_subtask'

function ChatView({ project, onBack, onOpenHistory, onError }: ChatViewProps) {
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null)
  const [hasChanges, setHasChanges] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

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
          case 'turn_complete':
            if (!isReplay) {
              setBusy(false)
              refreshHasChanges()
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
          setItems((prev) => [...prev, { kind: 'user_text', text: entry.text as string }])
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
    const unsubConfirm = window.vibe.chat.onConfirmationRequest((projectId, request) => {
      if (projectId === project.id) setConfirmation(request)
    })
    return () => {
      unsubEvent()
      unsubConfirm()
    }
  }, [project.id, applyEvent])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return
    setItems((prev) => [...prev, { kind: 'user_text', text }])
    setInput('')
    setBusy(true)
    try {
      await window.vibe.chat.send(project.id, project.path, text)
    } catch (err) {
      setBusy(false)
      onError(`Failed to send message: ${(err as Error).message}`)
    }
  }, [input, busy, project, onError])

  const handleConfirmation = useCallback(
    (approved: boolean) => {
      if (!confirmation) return
      window.vibe.chat.respondToConfirmation(project.id, confirmation.id, approved)
      setConfirmation(null)
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
          <button onClick={onOpenHistory}>History</button>
          <CheckpointButton
            hasChanges={hasChanges}
            onCheckpoint={handleCheckpoint}
            suggestMessage={suggestMessage}
          />
        </div>
      </div>

      <div className="chat-log" ref={scrollRef}>
        {items.map((item, i) => (
          <div key={i} className={`chat-item chat-item-${item.kind}`}>
            {item.kind === 'user_text' && <p>{item.text}</p>}
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
          </div>
        ))}
        {busy && <div className="chat-item chat-item-thinking">Claude is working…</div>}
      </div>

      {confirmation && (
        <div className="confirmation-banner">
          <span>
            Claude wants to run a potentially destructive command via {confirmation.toolName}.
            Allow it?
          </span>
          <div className="confirmation-actions">
            <button onClick={() => handleConfirmation(true)}>Allow</button>
            <button onClick={() => handleConfirmation(false)}>Deny</button>
          </div>
        </div>
      )}

      <div className="chat-input-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder="Tell VibeApp what to build…"
          disabled={busy}
        />
        <button onClick={handleSend} disabled={busy || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  )
}

export default ChatView
