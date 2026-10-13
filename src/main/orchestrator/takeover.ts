import { existsSync } from 'fs'
import type { VibeEvent } from '@shared/types'
import { runCodexExec } from '../cli/codexExec'
import { changeStats, takeSnapshot, type FileChange } from '../git/snapshots'
import { handoffContext } from '../memory/context'
import { memoryDb, memoryDbPath, memoryServerScriptPath } from '../memory/paths'
import { finishHandoff, keyFactsBlock, startHandoff } from '../memory/store'
import { verifyChanges } from '../review/checks'
import { getSettings } from '../settings/store'
import { countsFromCodexEvents, recordUsage } from '../usage/tokens'

// When Claude's plan is used up, Codex takes the user's request directly:
// same chat, same memory, same checks, just without Claude in the middle.

const DELEGATION_TOOL_NAME = 'mcp__vibe_tools__run_codex_subtask'
const TIMEOUT_MS = 15 * 60_000

/** Per project: the Codex session takeovers continue, so follow-ups keep their context. */
const threads = new Map<string, { id: string; unsandboxed: boolean }>()

/** Per project: what Codex handled while Claude was out, for Claude's catch-up note. */
const handled = new Map<string, { request: string; outcome: string }[]>()

export interface TakeoverRequest {
  projectId: string
  projectPath: string
  text: string
  /** Description of an element the user pointed at, if any. */
  element?: string
  /** Saved image files the user attached. */
  images: string[]
  resetsAt: number | null
  unsandboxed: boolean
  emit: (event: VibeEvent) => void
  signal: AbortSignal
}

function attempt<T>(work: () => T): T | undefined {
  try {
    return work()
  } catch (err) {
    console.warn('Takeover bookkeeping failed:', (err as Error).message)
    return undefined
  }
}

/** A note for Claude's next message, listing what Codex did while it was out. Clears the list. */
export function takeCatchUpNote(projectId: string): string | undefined {
  const items = handled.get(projectId)
  handled.delete(projectId)
  if (!items?.length) return undefined
  const lines = items.map((i, n) => `${n + 1}. "${i.request.slice(0, 200)}" -> ${i.outcome.slice(0, 400)}`)
  const many = items.length > 1
  return `[VibeApp note: while Claude's plan limit was reached, Codex handled ${many ? 'these requests' : 'this request'} directly, so the earlier conversation doesn't include ${many ? 'them' : 'it'}. The project files are current; the handoffs tool has the full reports.\n${lines.join('\n')}]`
}

export function forgetTakeover(projectId: string): void {
  threads.delete(projectId)
  handled.delete(projectId)
}

/** Runs one request on Codex and reports it to the chat as a normal (delegated) turn. */
export async function runTakeover(req: TakeoverRequest): Promise<void> {
  const { projectId, projectPath, emit, signal } = req
  const toolUseId = `takeover-${Date.now()}`
  const request = { text: req.text, element: req.element, images: req.images }
  const prompt = [req.text, req.element].filter(Boolean).join('\n\n')

  emit({ type: 'takeover_started', resetsAt: req.resetsAt })
  emit({
    type: 'tool_call',
    toolUseId,
    name: DELEGATION_TOOL_NAME,
    input: { prompt: req.text },
    friendlyLabel: 'Codex is handling your request'
  })

  const handoffId = attempt(() => startHandoff(memoryDb(), projectId, 'codex', prompt, req.text))
  const before = await takeSnapshot(projectPath, 'before takeover').catch(() => undefined)
  let status: 'done' | 'error' | 'stopped' = 'error'
  let report = ''
  let changes: FileChange[] | null = null
  let checks = ''

  try {
    const memory = {
      scriptPath: memoryServerScriptPath(),
      dbPath: memoryDbPath(),
      projectId,
      projectPath,
      keyFacts: attempt(() => keyFactsBlock(memoryDb(), projectId)),
      context: attempt(() => handoffContext(projectId, prompt, request)),
      // Claude's note-taker is out too, so Codex saves what it learns itself.
      autoMemory: false
    }
    const run = (resumeThreadId?: string) =>
      runCodexExec(
        {
          prompt,
          taskLabel: "The user's request",
          cwd: projectPath,
          timeoutMs: TIMEOUT_MS,
          unsandboxed: req.unsandboxed,
          model: getSettings().codexModel ?? undefined,
          images: req.images.filter((p) => existsSync(p)),
          resumeThreadId,
          memory,
          signal
        },
        (note) => emit({ type: 'delegation_progress', toolUseId, note }),
        (activity) => emit({ type: 'delegation_activity', activity })
      )

    const earlier = threads.get(projectId)
    const resumeId = earlier && earlier.unsandboxed === req.unsandboxed ? earlier.id : undefined
    let result = await run(resumeId)
    if (resumeId && result.exitCode !== 0 && !result.finalMessage && !signal.aborted) {
      threads.delete(projectId)
      recordUsage(projectId, 'takeover', 'codex', countsFromCodexEvents(result.events))
      result = await run(undefined)
    }
    if (result.threadId && result.exitCode === 0) {
      threads.set(projectId, { id: result.threadId, unsandboxed: req.unsandboxed })
    }
    const counts = countsFromCodexEvents(result.events)
    recordUsage(projectId, 'takeover', 'codex', counts)
    emit({
      type: 'usage',
      steps: counts.steps,
      fresh: counts.fresh,
      cached: counts.cached,
      output: counts.output,
      model: counts.model
    })

    status = result.exitCode === 0 ? 'done' : 'error'
    report = result.finalMessage || '(Codex finished with no final message.)'
    if (before) {
      const after = await takeSnapshot(projectPath, 'after takeover').catch(() => undefined)
      if (after) changes = await changeStats(projectPath, before, after).catch(() => null)
    }
    let checksOk = true
    if (status === 'done' && changes?.length) {
      const verdict = await verifyChanges(
        projectPath,
        changes.map((c) => c.path)
      ).catch(() => ({ ok: null as boolean | null, summary: '' }))
      checks = verdict.summary
      checksOk = verdict.ok !== false
    }
    emit({ type: 'tool_result', toolUseId, ok: status === 'done' && checksOk, summary: report.slice(0, 300), raw: null })
    emit({
      type: 'assistant_text',
      text: [report, checks && !checksOk ? `Automatic checks found a problem: ${checks}` : ''].filter(Boolean).join('\n\n'),
      partial: false
    })
  } catch (err) {
    if (signal.aborted) {
      status = 'stopped'
      report = 'Stopped by the user.'
      emit({ type: 'tool_result', toolUseId, ok: false, summary: 'Stopped.', raw: null })
      emit({ type: 'stopped' })
    } else {
      report = (err as Error).message
      emit({ type: 'tool_result', toolUseId, ok: false, summary: report, raw: null })
      emit({ type: 'error', message: `Codex couldn't finish this: ${report}` })
    }
  } finally {
    if (handoffId !== undefined) {
      attempt(() =>
        finishHandoff(memoryDb(), handoffId, {
          status,
          report: [report, checks].filter(Boolean).join('\n\n'),
          files: changes?.map((c) => c.path) ?? null
        })
      )
    }
    const list = handled.get(projectId) ?? []
    list.push({
      request: req.text,
      outcome: `${status}${changes?.length ? `, changed ${changes.length} file(s)` : ''}. ${report}`
    })
    handled.set(projectId, list.slice(-5))
    emit({ type: 'turn_complete' })
  }
}
