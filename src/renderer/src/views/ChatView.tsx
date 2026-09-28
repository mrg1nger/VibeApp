import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConfirmationRequest, ProjectRecord, VibeEvent } from '@shared/types'

interface ChatViewProps {
  project: ProjectRecord
  onBack: () => void
}

type ChatItem =
  | { kind: 'user_text'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool'; toolUseId: string; label: string; status: 'running' | 'ok' | 'error'; summary?: string }
  | { kind: 'error'; message: string }

function ChatView({ project, onBack }: ChatViewProps) {
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const applyEvent = useCallback((event: VibeEvent) => {
    setItems((prev) => {
      switch (event.type) {
        case 'assistant_text':
          return [...prev, { kind: 'assistant_text', text: event.text }]
        case 'tool_call':
          return [
            ...prev,
            { kind: 'tool', toolUseId: event.toolUseId, label: event.friendlyLabel, status: 'running' }
          ]
        case 'tool_result':
          return prev.map((item) =>
            item.kind === 'tool' && item.toolUseId === event.toolUseId
              ? { ...item, status: event.ok ? 'ok' : 'error', summary: event.summary }
              : item
          )
        case 'error':
          return [...prev, { kind: 'error', message: event.message }]
        case 'turn_complete':
          setBusy(false)
          return prev
        default:
          return prev
      }
    })
  }, [])

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
    await window.vibe.chat.send(project.id, project.path, text)
  }, [input, busy, project])

  const handleConfirmation = useCallback(
    (approved: boolean) => {
      if (!confirmation) return
      window.vibe.chat.respondToConfirmation(project.id, confirmation.id, approved)
      setConfirmation(null)
    },
    [confirmation, project.id]
  )

  return (
    <div className="chat-view">
      <div className="chat-header">
        <button onClick={onBack}>&larr; Projects</button>
        <span className="chat-project-name">{project.name}</span>
      </div>

      <div className="chat-log" ref={scrollRef}>
        {items.map((item, i) => (
          <div key={i} className={`chat-item chat-item-${item.kind}`}>
            {item.kind === 'user_text' && <p>{item.text}</p>}
            {item.kind === 'assistant_text' && <p>{item.text}</p>}
            {item.kind === 'tool' && (
              <div className={`tool-card tool-card-${item.status}`}>
                <span>{item.label}</span>
                {item.status === 'running' && <span className="tool-status">working…</span>}
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
