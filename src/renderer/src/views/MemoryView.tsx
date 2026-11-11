import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  MEMORY_CATEGORIES,
  type ApprovedPlan,
  type MemoryCategory,
  type MemoryFact,
  type MemoryScope,
  type MemorySearchStatus,
  type ProjectRecord
} from '@shared/types'
import Modal from '../components/Modal'
import Markdown from '../components/Markdown'

interface MemoryViewProps {
  project: ProjectRecord
  onBack: () => void
  onError?: (message: string) => void
}

const SOURCE_LABELS: Record<MemoryFact['source'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  user: 'You',
  tidy: 'Tidy-up',
  scribe: 'Saved automatically'
}

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  about: 'About the project',
  setup: 'Running & building',
  decision: 'Decisions',
  preference: 'Preferences',
  gotcha: 'Gotchas',
  other: 'Other'
}

function shortDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : ''
}

type Order = 'category' | 'useful'

/** Most recently looked up first, then most looked up; never looked up last, newest first. */
function usefulLately(a: MemoryFact, b: MemoryFact): number {
  if (!!a.lastUsedAt !== !!b.lastUsedAt) return a.lastUsedAt ? -1 : 1
  if (a.lastUsedAt && b.lastUsedAt && a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt > b.lastUsedAt ? -1 : 1
  return b.useCount - a.useCount || (b.updatedAt > a.updatedAt ? 1 : -1)
}

/** The plan a "plan approved" fact points at ("… (plan #3, full text in the plans memory tool)."). */
function planNumber(fact: MemoryFact): number | null {
  const m = /\(plan #(\d+)[,)]/.exec(fact.text)
  return m ? Number(m[1]) : null
}

function searchLine(status: MemorySearchStatus | null): string {
  if (!status) return ''
  if (!status.byMeaning) return "Memory is searched by keyword on this computer: the language model for searching by meaning can't run here."
  const waiting = status.facts - status.factsDone + (status.files - status.filesDone)
  return waiting > 0
    ? `Memory is searched by meaning. ${waiting} more ${waiting === 1 ? 'fact or file is' : 'facts and files are'} still being read; until then, searches go by keyword.`
    : `Memory is searched by meaning, on this computer (${status.factsDone} facts and ${status.filesDone} file summaries read).`
}

function MemoryView({ project, onBack, onError }: MemoryViewProps) {
  const [scope, setScope] = useState<MemoryScope>('project')
  const [facts, setFacts] = useState<MemoryFact[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showForgotten, setShowForgotten] = useState(false)
  const [newFact, setNewFact] = useState('')
  const [newCategory, setNewCategory] = useState<MemoryCategory>('other')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [tidying, setTidying] = useState(false)
  const [tidyNote, setTidyNote] = useState('')
  const [brief, setBrief] = useState<{ text: string; updatedAt: string } | null>(null)
  const [briefBusy, setBriefBusy] = useState(false)
  const [order, setOrder] = useState<Order>('category')
  const [status, setStatus] = useState<MemorySearchStatus | null>(null)
  const [plans, setPlans] = useState<ApprovedPlan[]>([])
  const [openPlan, setOpenPlan] = useState<ApprovedPlan | null>(null)

  const effectiveScope = scope
  const projectId = project.id
  const fail = useCallback((err: unknown) => onError?.((err as Error).message), [onError])

  const refresh = useCallback(() => {
    setLoading(true)
    window.vibe.memory
      .list(projectId, effectiveScope, showForgotten)
      .then(setFacts)
      .catch(fail)
      .finally(() => setLoading(false))
  }, [projectId, effectiveScope, showForgotten, fail])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    window.vibe.brief.get(project.id).then(setBrief).catch(() => undefined)
    window.vibe.memory.plans(project.id).then(setPlans).catch(() => undefined)
  }, [project])

  // Asked again every few seconds while facts are still being read (just after starting, or an update).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const ask = (): void => {
      window.vibe.memory
        .searchStatus()
        .then((s) => {
          if (stopped) return
          setStatus(s)
          if (s.byMeaning && s.factsDone + s.filesDone < s.facts + s.files) timer = setTimeout(ask, 3000)
        })
        .catch(() => undefined)
    }
    ask()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const showPlan = useCallback(
    (id: number) => {
      window.vibe.memory
        .plan(projectId, id)
        .then((plan) => (plan ? setOpenPlan(plan) : fail(new Error(`Plan #${id} is no longer saved.`))))
        .catch(fail)
    },
    [projectId, fail]
  )

  const refreshBrief = useCallback(async () => {
    setBriefBusy(true)
    try {
      setBrief(await window.vibe.brief.refresh(project.id, project.path))
    } catch (err) {
      fail(err)
    } finally {
      setBriefBusy(false)
    }
  }, [project, fail])

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action()
        refresh()
      } catch (err) {
        fail(err)
      }
    },
    [refresh, fail]
  )

  const handleAdd = useCallback(() => {
    const text = newFact.trim()
    if (!text) return
    run(async () => {
      await window.vibe.memory.add(projectId, effectiveScope, text, newCategory)
      setNewFact('')
    })
  }, [newFact, newCategory, projectId, effectiveScope, run])

  const handleSaveEdit = useCallback(() => {
    if (!editingId) return
    const id = editingId
    setEditingId(null)
    run(() => window.vibe.memory.update(id, { text: editingText.trim() }))
  }, [editingId, editingText, run])

  const handleTidy = useCallback(async () => {
    setTidying(true)
    setTidyNote('')
    try {
      const r = await window.vibe.memory.tidy(projectId, effectiveScope)
      const parts = [
        r.categorized ? `sorted ${r.categorized}` : '',
        r.merged ? `merged ${r.merged} duplicate${r.merged === 1 ? '' : 's'}` : '',
        r.outdated ? `retired ${r.outdated} outdated` : '',
        r.unused ? `retired ${r.unused} nobody had looked up in a long time` : '',
        r.checked ? `checked ${r.checked} fact${r.checked === 1 ? '' : 's'} whose files had changed and kept ${r.checked === 1 ? 'it' : 'them'}` : ''
      ].filter(Boolean)
      setTidyNote(
        parts.length
          ? `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}.${r.outdated + r.unused + r.merged ? ' Retired facts are under "Show forgotten".' : ''}`
          : 'Everything already looks tidy.'
      )
      refresh()
    } catch (err) {
      fail(err)
    } finally {
      setTidying(false)
    }
  }, [projectId, effectiveScope, refresh, fail])

  const needle = search.trim().toLowerCase()
  const visible = useMemo(
    () => facts.filter((f) => !needle || f.text.toLowerCase().includes(needle)),
    [facts, needle]
  )
  const active = visible.filter((f) => !f.forgottenAt)
  const forgotten = visible.filter((f) => f.forgottenAt)
  const keyFacts = active.filter((f) => f.key)
  const groups = MEMORY_CATEGORIES.map((category) => ({
    category,
    facts: active.filter((f) => !f.key && f.category === category)
  })).filter((g) => g.facts.length)
  const byUse = [...active].sort(usefulLately)
  const outdatedCount = active.filter((f) => f.mayBeOutdated).length
  const factText = (id: string | null): string | undefined => (id ? facts.find((f) => f.id === id)?.text : undefined)

  const renderFact = (fact: MemoryFact) => (
    <li key={fact.id} className={`memory-row${fact.forgottenAt ? ' memory-row-forgotten' : ''}`}>
      {!fact.forgottenAt && (
        <button
          className={`memory-key${fact.key ? ' on' : ''}`}
          title={fact.key ? 'Key fact: Claude and Codex always see it. Click to make it search-only.' : 'Make this a key fact (always shown to Claude and Codex)'}
          onClick={() => run(() => window.vibe.memory.update(fact.id, { key: !fact.key }))}
        >
          {fact.key ? '★' : '☆'}
        </button>
      )}
      <div className="memory-body">
        {editingId === fact.id ? (
          <input
            className="memory-edit-input"
            value={editingText}
            onChange={(e) => setEditingText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveEdit()
              if (e.key === 'Escape') setEditingId(null)
            }}
            autoFocus
          />
        ) : (
          <span className="memory-text">{fact.text}</span>
        )}
        {fact.mayBeOutdated && (
          <span
            className="memory-outdated"
            title="Claude, Codex and Cline are told this too. The next tidy-up checks it against the files; edit the fact if you know it's still right."
          >
            ⚠ May be out of date: {fact.mayBeOutdated}
          </span>
        )}
        <span className="memory-meta">
          {SOURCE_LABELS[fact.source] ?? fact.source} · {shortDate(fact.updatedAt)}
          {fact.useCount > 0 ? ` · looked up ${fact.useCount}×${fact.lastUsedAt ? `, last ${shortDate(fact.lastUsedAt)}` : ''}` : ' · not looked up yet'}
          {fact.files?.length ? ` · about ${fact.files.slice(0, 4).join(', ')}${fact.files.length > 4 ? ` and ${fact.files.length - 4} more` : ''}` : ''}
          {fact.forgottenAt ? ` · forgotten ${shortDate(fact.forgottenAt)}${fact.forgottenReason ? ` (${fact.forgottenReason})` : ''}` : ''}
        </span>
        {fact.forgottenAt && factText(fact.replacedBy) && <span className="memory-meta">Replaced by: {factText(fact.replacedBy)}</span>}
      </div>
      <div className="memory-row-actions">
        {fact.forgottenAt ? (
          <>
            <button onClick={() => run(() => window.vibe.memory.restore(fact.id))}>Restore</button>
            <button onClick={() => run(() => window.vibe.memory.delete(fact.id))}>Delete forever</button>
          </>
        ) : (
          <>
            {planNumber(fact) !== null && <button onClick={() => showPlan(planNumber(fact)!)}>Open plan</button>}
            <select
              value={fact.category}
              onChange={(e) => run(() => window.vibe.memory.update(fact.id, { category: e.target.value as MemoryCategory }))}
              title="Category"
            >
              {MEMORY_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
            {editingId === fact.id ? (
              <button onClick={handleSaveEdit}>Save</button>
            ) : (
              <button
                onClick={() => {
                  setEditingId(fact.id)
                  setEditingText(fact.text)
                }}
              >
                Edit
              </button>
            )}
            <button onClick={() => run(() => window.vibe.memory.forget(fact.id))} title="Retire it (you can restore it later)">
              Forget
            </button>
          </>
        )}
      </div>
    </li>
  )

  return (
    <div className="memory-view">
      <div className="chat-header">
        <button onClick={onBack}>&larr; Back</button>
        <span className="chat-project-name">{project.name} — Memory</span>
      </div>

      <div className="memory-scope-tabs">
        <button className={scope === 'project' ? 'active' : ''} onClick={() => setScope('project')}>
          This project
        </button>
        <button className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')}>
          All projects
        </button>
      </div>

      {effectiveScope === 'project' && (
        <details className="memory-brief" open={!!brief}>
          <summary>
            Project brief{brief ? ` (updated ${new Date(brief.updatedAt).toLocaleString()})` : ' (not written yet)'}
          </summary>
          <p className="memory-hint">
            A short summary of what this project is and how it's run, tested and deployed, built from the facts below
            and the commands that were run. New Claude sessions and Codex start from it. It's rewritten automatically
            now and then and before a fresh session starts.
          </p>
          {brief && <pre style={{ whiteSpace: 'pre-wrap' }}>{brief.text}</pre>}
          <button onClick={refreshBrief} disabled={briefBusy}>
            {briefBusy ? 'Writing…' : brief ? 'Rewrite it now' : 'Write it now'}
          </button>
        </details>
      )}

      <p className="memory-hint">
        ★ Key facts are given to Claude and Codex at the start of every request. The rest are searched when a request
        needs them.
      </p>
      {status && <p className="memory-hint">{searchLine(status)}</p>}

      <div className="memory-toolbar">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search memory…" />
        <select value={order} onChange={(e) => setOrder(e.target.value as Order)} title="How the facts are listed">
          <option value="category">By category</option>
          <option value="useful">Useful lately</option>
        </select>
        <label className="memory-toggle">
          <input type="checkbox" checked={showForgotten} onChange={(e) => setShowForgotten(e.target.checked)} />
          Show forgotten
        </label>
        <button onClick={handleTidy} disabled={tidying} title="Haiku sorts new facts, merges duplicates and retires outdated ones">
          {tidying ? 'Tidying…' : 'Tidy up now'}
        </button>
      </div>
      {tidyNote && <p className="memory-hint">{tidyNote}</p>}
      {outdatedCount > 0 && (
        <p className="memory-hint">
          ⚠ {outdatedCount === 1 ? '1 fact' : `${outdatedCount} facts`} may be out of date: the files{' '}
          {outdatedCount === 1 ? 'it is' : 'they are'} about changed a lot or are gone. The next tidy-up checks{' '}
          {outdatedCount === 1 ? 'it' : 'them'} first.
        </p>
      )}

      <div className="memory-add-row">
        <input
          value={newFact}
          onChange={(e) => setNewFact(e.target.value)}
          placeholder={effectiveScope === 'global' ? 'Add a fact for all projects…' : "Add a fact to this project's memory…"}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
        />
        <select value={newCategory} onChange={(e) => setNewCategory(e.target.value as MemoryCategory)}>
          {MEMORY_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <button onClick={handleAdd} disabled={!newFact.trim()}>
          Add
        </button>
      </div>

      <div className="memory-list-scroll">
        {loading && <p>Loading…</p>}
        {!loading && active.length === 0 && forgotten.length === 0 && (
          <p className="memory-hint">{needle ? 'Nothing matches that search.' : 'Nothing remembered here yet.'}</p>
        )}

        {order === 'useful' && byUse.length > 0 && (
          <section>
            <h3 className="memory-group-title">Most recently looked up first ({byUse.length})</h3>
            <ul className="memory-list">{byUse.map(renderFact)}</ul>
          </section>
        )}
        {order === 'category' && keyFacts.length > 0 && (
          <section>
            <h3 className="memory-group-title">★ Key facts ({keyFacts.length})</h3>
            <ul className="memory-list">{keyFacts.map(renderFact)}</ul>
          </section>
        )}
        {order === 'category' &&
          groups.map((g) => (
          <section key={g.category}>
            <h3 className="memory-group-title">
              {CATEGORY_LABELS[g.category]} ({g.facts.length})
            </h3>
            <ul className="memory-list">{g.facts.map(renderFact)}</ul>
          </section>
        ))}
        {showForgotten && forgotten.length > 0 && (
          <section>
            <h3 className="memory-group-title">Forgotten ({forgotten.length})</h3>
            <ul className="memory-list">{forgotten.map(renderFact)}</ul>
          </section>
        )}
        {effectiveScope === 'project' && plans.length > 0 && !needle && (
          <section>
            <h3 className="memory-group-title">Approved plans ({plans.length})</h3>
            <ul className="memory-list">
              {plans.map((p) => (
                <li key={p.id} className="memory-row">
                  <div className="memory-body">
                    <span className="memory-text">{p.title}</span>
                    <span className="memory-meta">
                      Plan #{p.id} · approved {shortDate(p.approvedAt)}
                    </span>
                  </div>
                  <div className="memory-row-actions">
                    <button onClick={() => setOpenPlan(p)}>Open</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {openPlan && (
        <Modal title={`Plan #${openPlan.id}, approved ${shortDate(openPlan.approvedAt)}`} onClose={() => setOpenPlan(null)} wide>
          <div className="memory-plan-text">
            <Markdown text={openPlan.text} />
          </div>
        </Modal>
      )}
    </div>
  )
}

export default MemoryView
