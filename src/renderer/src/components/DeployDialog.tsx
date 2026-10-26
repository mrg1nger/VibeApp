import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { DeployEvent, DeployRecipe, DeployStep, ProjectRecord } from '@shared/types'
import Modal from './Modal'

interface DeployDialogProps {
  project: ProjectRecord
  /** A chat request is running (setting up or fixing waits for it). */
  busy: boolean
  onClose: () => void
  onError: (message: string) => void
  /** Sends a Build message to Claude in this project's chat. */
  onAskClaude: (text: string) => void
}

export const DEPLOY_SETUP_PROMPT =
  "Set up the one-click Deploy button for this project. Work out how it's deployed: recall \"Procedure\" and \"deploy\" in memory, look back at the conversation history, and check the project's scripts and config. Then save the recipe with save_deploy_recipe: the exact steps that worked before, in order, a check URL that answers once it's live, and rollback steps if that's possible. Don't deploy now. If it has never been deployed, ask me where and how it should go first."

type StepState = 'waiting' | 'running' | 'ok' | 'failed'

interface Run {
  steps: string[]
  states: StepState[]
  check: StepState | null
  checkDetail?: string
  rollback: StepState | null
  log: string
  finished?: Extract<DeployEvent, { type: 'finished' }>
}

const MARK: Record<StepState, string> = { waiting: '○', running: '▶', ok: '✓', failed: '✗' }
const LOG_KEEP = 8000

function blankStep(): DeployStep {
  return { label: '', run: '' }
}

/** The project's one-click Deploy: set it up (Claude writes the recipe), check it, run it, follow it. */
function DeployDialog({ project, busy, onClose, onError, onAskClaude }: DeployDialogProps) {
  const [recipe, setRecipe] = useState<DeployRecipe | null | undefined>(undefined)
  const [draft, setDraft] = useState<DeployRecipe | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [change, setChange] = useState('')
  const [saving, setSaving] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  const load = useCallback(() => {
    window.vibe.deploy
      .get(project.id)
      .then(({ recipe: r, running }) => {
        setRecipe(r)
        // A recipe Claude wrote opens straight into checking it.
        setDraft((d) => d ?? (r && !r.confirmed ? r : null))
        if (running) setRun((prev) => prev ?? { steps: r?.steps.map((s) => s.label) ?? [], states: [], check: null, rollback: null, log: '' })
      })
      .catch((err: Error) => onError(err.message))
  }, [project.id, onError])

  useEffect(() => {
    load()
    const offChanged = window.vibe.deploy.onChanged((id) => id === project.id && load())
    const offEvent = window.vibe.deploy.onEvent((id, event) => {
      if (id !== project.id) return
      setRun((prev) => {
        if (event.type === 'started') {
          return { steps: event.steps, states: event.steps.map(() => 'waiting'), check: event.hasCheck ? 'waiting' : null, rollback: null, log: '' }
        }
        if (!prev) return prev
        switch (event.type) {
          case 'step':
            return { ...prev, states: prev.states.map((s, i) => (i === event.index ? event.status : s)) }
          case 'output':
            return { ...prev, log: (prev.log + event.text).slice(-LOG_KEEP) }
          case 'check':
            return { ...prev, check: event.status, checkDetail: event.detail ?? prev.checkDetail }
          case 'rollback':
            return { ...prev, rollback: event.status }
          case 'finished':
            return { ...prev, finished: event }
          default:
            return prev
        }
      })
    })
    return () => {
      offChanged()
      offEvent()
    }
  }, [project.id, load])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [run?.log])

  const deploying = !!run && !run.finished

  const startDeploy = async (): Promise<void> => {
    try {
      setRun({ steps: recipe?.steps.map((s) => s.label) ?? [], states: [], check: null, rollback: null, log: '' })
      await window.vibe.deploy.run(project.id, project.path)
    } catch (err) {
      setRun(null)
      onError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    try {
      setRecipe(await window.vibe.deploy.save(project.id, draft))
      setDraft(null)
    } catch (err) {
      onError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setSaving(false)
    }
  }

  const ask = (text: string): void => {
    onAskClaude(text)
    onClose()
  }

  const editSteps = (key: 'steps' | 'rollback', steps: DeployStep[]): void => setDraft((d) => (d ? { ...d, [key]: steps } : d))

  const stepEditor = (key: 'steps' | 'rollback'): ReactElement => {
    const steps = draft?.[key] ?? []
    return (
      <ol className="deploy-edit-steps">
        {steps.map((step, i) => (
          <li key={i}>
            <input
              value={step.label}
              placeholder="What it does"
              onChange={(e) => editSteps(key, steps.map((s, j) => (j === i ? { ...s, label: e.target.value } : s)))}
            />
            <textarea
              rows={Math.min(6, Math.max(2, Math.ceil(step.run.length / 70)))}
              value={step.run}
              spellCheck={false}
              placeholder="The command"
              onChange={(e) => editSteps(key, steps.map((s, j) => (j === i ? { ...s, run: e.target.value } : s)))}
            />
            <button className="chat-inline-action" onClick={() => editSteps(key, steps.filter((_, j) => j !== i))}>
              Remove
            </button>
          </li>
        ))}
        <li>
          <button className="chat-inline-action" onClick={() => editSteps(key, [...steps, blankStep()])}>
            + Add a step
          </button>
        </li>
      </ol>
    )
  }

  let body: ReactElement
  if (recipe === undefined) {
    body = <p className="modal-text">Loading…</p>
  } else if (draft) {
    body = (
      <>
        <p className="modal-text">
          {recipe?.confirmed
            ? 'Change the steps, then save.'
            : "Claude wrote these steps from how this project has been deployed. Check they're right: Deploy runs them on this computer exactly as written, with no AI looking at them."}
        </p>
        {draft.notes && <p className="modal-muted">Claude's note: {draft.notes}</p>}
        <label className="settings-field">
          Name
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="settings-field">
          Runs in
          <select value={draft.shell} onChange={(e) => setDraft({ ...draft, shell: e.target.value as DeployRecipe['shell'] })}>
            <option value="bash">Git Bash</option>
            <option value="powershell">PowerShell</option>
          </select>
        </label>
        <h4 className="deploy-heading">Steps (stop at the first one that fails)</h4>
        {stepEditor('steps')}
        <label className="settings-field">
          Check once it's live (a web address; leave empty for none)
          <input
            value={draft.check?.url ?? ''}
            placeholder="https://example.com/"
            onChange={(e) => setDraft({ ...draft, check: e.target.value.trim() ? { url: e.target.value.trim() } : undefined })}
          />
        </label>
        <h4 className="deploy-heading">If a step or the check fails, put it back by (optional)</h4>
        {stepEditor('rollback')}
        <div className="modal-actions">
          <button className="modal-primary" disabled={saving} onClick={saveDraft}>
            {recipe?.confirmed ? 'Save' : 'Looks right, save it'}
          </button>
          {recipe?.confirmed && <button onClick={() => setDraft(null)}>Cancel</button>}
        </div>
        <div className="deploy-change">
          <textarea rows={2} value={change} onChange={(e) => setChange(e.target.value)} placeholder="Or tell Claude what to change, e.g. also run the tests first" />
          <button disabled={busy || !change.trim()} onClick={() => ask(`Change the Deploy recipe: ${change.trim()}`)}>
            Ask Claude to change it
          </button>
        </div>
      </>
    )
  } else if (!recipe) {
    body = (
      <>
        <p className="modal-text">
          Deploy puts this project live with one click: VibeApp runs the steps itself, with no AI and no usage, and checks the
          site came back. Claude writes the steps once, from how you've deployed before, and you check them here.
        </p>
        <div className="modal-actions">
          <button className="modal-primary" disabled={busy} onClick={() => ask(DEPLOY_SETUP_PROMPT)}>
            Set up Deploy
          </button>
        </div>
        {busy && <p className="modal-muted">Waiting for the current request to finish.</p>}
      </>
    )
  } else {
    const states = run?.states.length ? run.states : recipe.steps.map(() => 'waiting' as StepState)
    body = (
      <>
        <ol className="deploy-steps">
          {recipe.steps.map((step, i) => (
            <li key={i} className={`deploy-step deploy-step-${states[i] ?? 'waiting'}`} title={step.run}>
              <span className="deploy-mark">{MARK[states[i] ?? 'waiting']}</span> {step.label}
            </li>
          ))}
          {recipe.check && (
            <li className={`deploy-step deploy-step-${run?.check ?? 'waiting'}`} title={recipe.check.url}>
              <span className="deploy-mark">{MARK[run?.check ?? 'waiting']}</span> Check {recipe.check.url} answers
            </li>
          )}
          {run?.rollback && (
            <li className={`deploy-step deploy-step-${run.rollback}`}>
              <span className="deploy-mark">{MARK[run.rollback]}</span> Putting the previous version back
            </li>
          )}
        </ol>
        {run?.finished && (
          <p className={run.finished.ok ? 'deploy-result-ok' : 'deploy-result-bad'}>
            {run.finished.ok
              ? `✓ Deployed in ${run.finished.seconds}s.${run.finished.checkDetail ? ` ${run.finished.checkDetail}.` : ''}`
              : `✗ ${run.finished.stopped ? 'Stopped' : `Failed at "${run.finished.failedStep}"`}${run.finished.rolledBack ? '; the previous version was put back' : ''}.${run.finished.checkDetail ? ` ${run.finished.checkDetail}.` : ''}`}
          </p>
        )}
        {run && run.log && (
          <pre className="deploy-log" ref={logRef}>
            {run.log}
          </pre>
        )}
        <div className="modal-actions">
          {deploying ? (
            <button onClick={() => window.vibe.deploy.stop(project.id)}>Stop</button>
          ) : (
            <button className="modal-primary" onClick={startDeploy}>
              🚀 {run?.finished ? 'Deploy again' : 'Deploy now'}
            </button>
          )}
          {!deploying && run?.finished && !run.finished.ok && (
            <button
              disabled={busy}
              onClick={() =>
                ask(
                  `The Deploy button ("${recipe.name}") failed at "${run.finished?.failedStep}"${run.finished?.rolledBack ? ' (the rollback steps ran)' : ''}. Last output:\n${(run.finished?.output ?? run.finished?.checkDetail ?? run.log).slice(-1500)}\nFind out why and fix it. If a step in the recipe is wrong, fix the recipe too with save_deploy_recipe. Don't run the deploy yourself.`
                )
              }
            >
              Ask Claude to fix it
            </button>
          )}
          {!deploying && <button onClick={() => setDraft(recipe)}>Edit steps</button>}
        </div>
        {busy && !deploying && <p className="modal-muted">A request is running in the chat; deploying now ships whatever is in the files at this moment.</p>}
      </>
    )
  }

  return (
    <Modal title={recipe?.name ? `Deploy: ${recipe.name}` : 'Deploy'} onClose={onClose} wide>
      {body}
    </Modal>
  )
}

export default DeployDialog
