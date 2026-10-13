import { useCallback, useEffect, useRef, useState } from 'react'
import type { TalkAgent, TalkConversation, TalkSummary } from '@shared/types'
import Markdown from '../components/Markdown'

interface TalkViewProps {
  onError: (message: string) => void
}

const AGENT_PREF_KEY = 'vibeapp.talkAgent'

function readAgentPref(): TalkAgent {
  try {
    return localStorage.getItem(AGENT_PREF_KEY) === 'codex' ? 'codex' : 'claude'
  } catch {
    return 'claude'
  }
}

function newId(): string {
  return crypto.randomUUID()
}

const AGENT_NAMES: Record<TalkAgent, string> = { claude: 'Claude', codex: 'Codex' }

/** A general chat that isn't tied to any project, with Claude or Codex answering. */
function TalkView({ onError }: TalkViewProps) {
  const [list, setList] = useState<TalkSummary[]>([])
  const [activeId, setActiveId] = useState<string>(newId)
  const [conversation, setConversation] = useState<TalkConversation | null>(null)
  const [agent, setAgent] = useState<TalkAgent>(readAgentPref)
  const [input, setInput] = useState('')
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const refreshList = useCallback(() => {
    window.vibe.talk.list().then(setList).catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshList()
  }, [refreshList])

  useEffect(() => {
    let cancelled = false
    window.vibe.talk
      .load(activeId)
      .then((c) => {
        if (!cancelled) setConversation(c)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeId])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [conversation, pendingText, busy])

  const chooseAgent = (next: TalkAgent): void => {
    setAgent(next)
    try {
      localStorage.setItem(AGENT_PREF_KEY, next)
    } catch {
      // A remembered preference only.
    }
  }

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return
    const id = activeId
    setInput('')
    setPendingText(text)
    setBusy(true)
    try {
      const updated = await window.vibe.talk.send(id, text, agent)
      setConversation(updated)
      refreshList()
    } catch (err) {
      const message = (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      if (message !== 'Stopped.') onError(message)
      // The question was saved even though the answer wasn't: show it.
      window.vibe.talk.load(id).then(setConversation).catch(() => undefined)
      refreshList()
    } finally {
      setPendingText(null)
      setBusy(false)
    }
  }, [input, busy, activeId, agent, onError, refreshList])

  const messages = conversation?.messages ?? []

  return (
    <div className="talk-view">
      <aside className="talk-sidebar">
        <button
          onClick={() => {
            setActiveId(newId())
            setConversation(null)
          }}
          disabled={busy}
        >
          + New chat
        </button>
        {list.map((c) => (
          <button
            key={c.id}
            className={`talk-conv ${c.id === activeId ? 'active' : ''}`}
            disabled={busy}
            title={c.title}
            onClick={() => setActiveId(c.id)}
          >
            {c.title}
          </button>
        ))}
        {conversation && list.some((c) => c.id === activeId) && (
          <button
            className="chat-inline-action"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm('Delete this conversation?')) return
              await window.vibe.talk.delete(activeId).catch(() => undefined)
              setActiveId(newId())
              setConversation(null)
              refreshList()
            }}
          >
            Delete this chat
          </button>
        )}
      </aside>

      <div className="talk-main">
        <div className="talk-log" ref={logRef}>
          {messages.length === 0 && !pendingText && (
            <div className="talk-empty">
              <h2>Ask anything</h2>
              <p>
                A plain chat with no project attached, for questions, ideas and drafts. Pick Claude or Codex below,
                and switch whenever you like: the conversation carries over.
              </p>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="talk-msg talk-msg-user">
                {m.text}
              </div>
            ) : (
              <div key={i} className="talk-msg">
                <span className="talk-msg-who">{AGENT_NAMES[m.agent ?? 'claude']}</span>
                <Markdown text={m.text} />
              </div>
            )
          )}
          {pendingText && <div className="talk-msg talk-msg-user">{pendingText}</div>}
          {busy && <div className="chat-item chat-item-thinking">{AGENT_NAMES[agent]} is thinking…</div>}
        </div>

        <div className="talk-compose">
          <div className="chat-mode-switch" role="group" aria-label="Who answers">
            {(['claude', 'codex'] as const).map((a) => (
              <button
                key={a}
                className={agent === a ? 'active' : ''}
                onClick={() => chooseAgent(a)}
                title={`Send your next message to ${AGENT_NAMES[a]}`}
              >
                {AGENT_NAMES[a]}
              </button>
            ))}
          </div>
          <div className="chat-input-row">
            <textarea
              className="chat-input"
              rows={1}
              value={input}
              disabled={busy}
              placeholder={`Ask ${AGENT_NAMES[agent]} anything…`}
              title="Enter to send · Shift+Enter for a new line"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            {busy ? (
              <button className="chat-stop" onClick={() => window.vibe.talk.stop(activeId)}>
                ■ Stop
              </button>
            ) : (
              <button onClick={send} disabled={!input.trim()}>
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default TalkView
