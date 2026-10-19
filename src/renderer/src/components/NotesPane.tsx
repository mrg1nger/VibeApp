import { useCallback, useEffect, useRef, useState } from 'react'
import type { TodoItem } from '@shared/types'
import { detectSecrets } from '@shared/secretPatterns'
import Markdown from './Markdown'

interface NotesPaneProps {
  projectId: string
  /** A request is running: "Build this" waits until it's done. */
  busy: boolean
  /** Send a to-do to the chat (in Plan mode if plan is true). */
  onBuild: (todo: TodoItem, plan: boolean) => void
  onOpenSecrets: () => void
  onError: (message: string) => void
}

const SAVE_DELAY_MS = 700

/** The project's Notes tab: the user's to-do list, then free notes. */
function NotesPane({ projectId, busy, onBuild, onOpenSecrets, onError }: NotesPaneProps) {
  const [todos, setTodos] = useState<TodoItem[] | null>(null)
  const [newTodo, setNewTodo] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)

  const [notes, setNotes] = useState('')
  const [notesLoaded, setNotesLoaded] = useState(false)
  const [editingNotes, setEditingNotes] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingNotes = useRef<string | null>(null)
  const lastSavedAt = useRef<string | null>(null)

  const loadTodos = useCallback(() => {
    window.vibe.todos
      .list(projectId)
      .then(setTodos)
      .catch((err: Error) => onError(`Couldn't load the to-do list: ${err.message}`))
  }, [projectId, onError])

  useEffect(() => {
    setTodos(null)
    loadTodos()
    return window.vibe.todos.onChanged((id) => {
      if (id === projectId) loadTodos()
    })
  }, [projectId, loadTodos])

  // Notes: loaded once, saved as you type; another window's change is picked up when not editing here.
  useEffect(() => {
    setNotesLoaded(false)
    setEditingNotes(false)
    window.vibe.notes
      .get(projectId)
      .then((n) => {
        setNotes(n.text)
        lastSavedAt.current = n.updatedAt
        setNotesLoaded(true)
        setEditingNotes(!n.text.trim())
      })
      .catch((err: Error) => onError(`Couldn't load the notes: ${err.message}`))
    return window.vibe.notes.onChanged((id, updatedAt) => {
      if (id !== projectId || updatedAt === lastSavedAt.current || pendingNotes.current !== null) return
      window.vibe.notes.get(projectId).then((n) => {
        if (pendingNotes.current !== null) return
        lastSavedAt.current = n.updatedAt
        setNotes(n.text)
      })
    })
  }, [projectId, onError])

  const flushNotes = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const text = pendingNotes.current
    if (text === null) return
    setSaveState('saving')
    window.vibe.notes
      .set(projectId, text)
      .then(({ updatedAt }) => {
        lastSavedAt.current = updatedAt
        if (pendingNotes.current === text) {
          pendingNotes.current = null
          setSaveState('saved')
        }
      })
      .catch((err: Error) => {
        setSaveState('unsaved')
        onError(`Couldn't save the notes: ${err.message}`)
      })
  }, [projectId, onError])

  // Nothing typed is lost when the tab is closed or another project is opened.
  useEffect(() => () => flushNotes(), [flushNotes])

  const changeNotes = (text: string): void => {
    setNotes(text)
    pendingNotes.current = text
    setSaveState('unsaved')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flushNotes, SAVE_DELAY_MS)
  }

  const act = useCallback(
    (work: Promise<TodoItem[]>) => {
      work.then(setTodos).catch((err: Error) => onError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
    },
    [onError]
  )

  const addTodo = (): void => {
    const text = newTodo.trim()
    if (!text) return
    setNewTodo('')
    act(window.vibe.todos.add(projectId, text))
  }

  const saveEdit = (): void => {
    if (!editing) return
    const text = editing.text.trim()
    setEditing(null)
    const before = todos?.find((t) => t.id === editing.id)?.text
    if (text && text !== before) act(window.vibe.todos.update(projectId, editing.id, { text }))
  }

  const open = (todos ?? []).filter((t) => !t.done)
  const done = (todos ?? []).filter((t) => t.done)

  const dropOn = (targetId: string): void => {
    if (!dragId || dragId === targetId) return
    const ids = open.map((t) => t.id).filter((id) => id !== dragId)
    ids.splice(ids.indexOf(targetId), 0, dragId)
    setTodos([...ids.map((id) => open.find((t) => t.id === id) as TodoItem), ...done])
    act(window.vibe.todos.reorder(projectId, ids))
  }

  const secrets = detectSecrets(notes)

  return (
    <div className="notes-pane">
      <section className="notes-section">
        <h3>To-do</h3>
        <form
          className="todo-add"
          onSubmit={(e) => {
            e.preventDefault()
            addTodo()
          }}
        >
          <input
            value={newTodo}
            onChange={(e) => setNewTodo(e.target.value)}
            placeholder="Add a to-do…"
            maxLength={300}
            aria-label="New to-do"
          />
          <button type="submit" disabled={!newTodo.trim()}>
            Add
          </button>
        </form>

        {todos === null && <p className="review-muted">Loading…</p>}
        {todos !== null && open.length === 0 && (
          <p className="review-muted">
            Nothing to do yet. Add things you want done later; Claude and Codex add leftovers here too.
          </p>
        )}
        <ul className="todo-list">
          {open.map((todo) => (
            <li
              key={todo.id}
              className={`todo-item${dragId === todo.id ? ' dragging' : ''}`}
              draggable={!editing}
              onDragStart={() => setDragId(todo.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                dropOn(todo.id)
              }}
            >
              <input
                type="checkbox"
                checked={false}
                aria-label={`Done: ${todo.text}`}
                onChange={() => act(window.vibe.todos.update(projectId, todo.id, { done: true }))}
              />
              {editing?.id === todo.id ? (
                <input
                  className="todo-edit"
                  autoFocus
                  value={editing.text}
                  maxLength={300}
                  onChange={(e) => setEditing({ id: todo.id, text: e.target.value })}
                  onBlur={saveEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <span className="todo-text" title="Click to edit" onClick={() => setEditing({ id: todo.id, text: todo.text })}>
                  {todo.text}
                  {todo.source !== 'user' && (
                    <span className={`plan-who plan-who-${todo.source}`}>from {todo.source === 'codex' ? 'Codex' : 'Claude'}</span>
                  )}
                </span>
              )}
              <button
                className="todo-build"
                disabled={busy}
                title={busy ? 'Waiting for the current request to finish' : 'Send this to the chat (Shift-click: plan it first)'}
                onClick={(e) => onBuild(todo, e.shiftKey)}
              >
                ▶ Build this
              </button>
              <button
                className="chat-inline-action todo-remove"
                title="Delete"
                aria-label={`Delete: ${todo.text}`}
                onClick={() => act(window.vibe.todos.remove(projectId, todo.id))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>

        {done.length > 0 && (
          <div className="todo-done">
            <button className="chat-inline-action" onClick={() => setShowDone((s) => !s)}>
              {showDone ? '▾' : '▸'} Done ({done.length})
            </button>
            {showDone && (
              <>
                <ul className="todo-list">
                  {done.map((todo) => (
                    <li key={todo.id} className="todo-item todo-item-done">
                      <input
                        type="checkbox"
                        checked
                        aria-label={`Not done: ${todo.text}`}
                        onChange={() => act(window.vibe.todos.update(projectId, todo.id, { done: false }))}
                      />
                      <span className="todo-text">{todo.text}</span>
                      <button
                        className="chat-inline-action todo-remove"
                        aria-label={`Delete: ${todo.text}`}
                        onClick={() => act(window.vibe.todos.remove(projectId, todo.id))}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
                <button className="chat-inline-action" onClick={() => act(window.vibe.todos.clearDone(projectId))}>
                  Clear done
                </button>
              </>
            )}
          </div>
        )}
      </section>

      <section className="notes-section notes-free">
        <div className="notes-heading">
          <h3>Notes</h3>
          <span className="review-muted notes-save-state">
            {saveState === 'saving' ? 'Saving…' : saveState === 'unsaved' ? 'Not saved yet' : notesLoaded && notes ? 'Saved' : ''}
          </span>
          {notesLoaded && notes.trim() && (
            <button className="chat-inline-action" onClick={() => (editingNotes ? (flushNotes(), setEditingNotes(false)) : setEditingNotes(true))}>
              {editingNotes ? 'Done' : 'Edit'}
            </button>
          )}
        </div>
        {secrets.length > 0 && (
          <div className="notes-secret-warning">
            ⚠️ This looks like {secrets.length === 1 ? 'a secret key' : 'secret keys'} ({secrets.map((s) => `${s.label} …${s.value.slice(-4)}`).join(', ')}).
            Notes aren't encrypted, and Claude or Codex read them when you ask. Keep keys in Secrets instead.{' '}
            <button className="chat-inline-action" onClick={onOpenSecrets}>
              🔑 Open Secrets
            </button>
          </div>
        )}
        {!notesLoaded ? (
          <p className="review-muted">Loading…</p>
        ) : editingNotes ? (
          <textarea
            className="notes-text"
            value={notes}
            onChange={(e) => changeNotes(e.target.value)}
            onBlur={flushNotes}
            placeholder={'Anything worth keeping for this project: addresses to test, steps, ideas.\nClaude and Codex only read this when you ask them to.'}
            aria-label="Notes"
          />
        ) : (
          <div className="notes-view" onDoubleClick={() => setEditingNotes(true)} title="Double-click to edit">
            <Markdown text={notes} />
          </div>
        )}
      </section>
    </div>
  )
}

export default NotesPane
