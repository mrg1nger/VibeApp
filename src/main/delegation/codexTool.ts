import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'fs'
import * as z from 'zod/v4'
import { runCodexExec, type CodexExecArgs, type CodexExecResult } from '../cli/codexExec'
import { getSettings } from '../settings/store'
import { memoryDb } from '../memory/paths'
import { finishHandoff, keyFactsBlock, startHandoff } from '../memory/store'
import { handoffContext } from '../memory/context'
import { changeStats, diffSnapshots, takeSnapshot, type FileChange } from '../git/snapshots'
import { verifyChanges } from '../review/checks'
import { countsFromCodexEvents, recordUsage } from '../usage/tokens'

export type DelegationProgressListener = (note: string) => void

/** What the user asked for in this turn, in their own words, to pass along with a hand-off. */
export interface RequestContext {
  text: string
  /** Description of an element they pointed at in the preview. */
  element?: string
  /** Paths of images they attached (the originals). */
  images: string[]
}

/** A Codex session that later hand-offs in the same request can pick up. */
export interface CodexThread {
  id: string
  /** The mode it was started in; a session isn't carried across a Go Nutz change. */
  unsandboxed: boolean
}

/** Longest summary returned to Claude; the full report is kept for the handoffs tool. */
const SUMMARY_CHARS = 1500
/** A diff this small is included, so Claude doesn't have to open the files to review it. */
const DIFF_INLINE_CHARS = 4000

function currentKeyFacts(projectId: string): string | undefined {
  try {
    return keyFactsBlock(memoryDb(), projectId)
  } catch {
    return undefined // memory unavailable: Codex can still search it
  }
}

/** Never lets bookkeeping failures get in the way of the hand-off itself. */
function attempt<T>(work: () => T): T | undefined {
  try {
    return work()
  } catch (err) {
    console.warn('Hand-off bookkeeping failed:', (err as Error).message)
    return undefined
  }
}

function describeChanges(changes: FileChange[]): string {
  const shown = changes.slice(0, 12).map((c) => {
    const delta = [c.added ? `+${c.added}` : '', c.removed ? `-${c.removed}` : ''].filter(Boolean).join(' ')
    return `${c.path}${delta ? ` (${delta})` : ''}`
  })
  return `${shown.join(', ')}${changes.length > 12 ? ` and ${changes.length - 12} more` : ''}`
}

export function createCodexDelegationServer(
  projectPath: string,
  onProgress: DelegationProgressListener,
  isGoNutzMode: () => boolean,
  memory?: NonNullable<CodexExecArgs['memory']>,
  /** Aborted when the user presses Stop. */
  getStopSignal?: () => AbortSignal,
  getRequestContext?: () => RequestContext | undefined,
  codexThread?: { get: () => CodexThread | undefined; set: (thread: CodexThread | undefined) => void }
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: 'vibe_tools',
    version: '1.0.0',
    tools: [
      tool(
        'run_codex_subtask',
        "Delegate a scoped coding subtask to the Codex CLI (a separate AI coding agent) and return its result. Useful for getting a second implementation, a second opinion, or offloading an independent chunk of work. Codex is automatically given the user's original request, the key facts, relevant memories and recent hand-offs, and several hand-offs in one request continue the same Codex session, so a task only needs to say what to do, which files are involved, and what \"done\" looks like. The result is a short summary, the files changed (with a small diff) and the outcome of automatic checks (script syntax, JSON, the project's npm test); the full report is available from the handoffs tool.",
        {
          prompt: z.string().describe('The subtask instructions for Codex to carry out.'),
          timeoutMs: z
            .number()
            .optional()
            .describe('Optional timeout in milliseconds. Defaults to 5 minutes.')
        },
        async (args) => {
          const signal = getStopSignal?.()
          const request = getRequestContext?.()
          const projectId = memory?.projectId
          const unsandboxed = isGoNutzMode()

          // Log it, and note which files change (snapshots before and after).
          const handoffId = projectId
            ? attempt(() => startHandoff(memoryDb(), projectId, 'codex', args.prompt, request?.text ?? null))
            : undefined
          const before = await takeSnapshot(projectPath, 'before hand-off').catch(() => undefined)

          interface Outcome {
            changes: FileChange[] | null
            diff: string
            checks: string
            checksOk: boolean | null
          }
          const outcome = async (status: 'done' | 'error' | 'stopped', report: string): Promise<Outcome> => {
            let changes: FileChange[] | null = null
            let diff = ''
            let checks = ''
            let checksOk: boolean | null = null
            if (before) {
              const after = await takeSnapshot(projectPath, 'after hand-off').catch(() => undefined)
              if (after) {
                changes = await changeStats(projectPath, before, after).catch(() => null)
                if (changes?.length && status === 'done') {
                  diff = await diffSnapshots(projectPath, before, after).catch(() => '')
                }
              }
            }
            // Only worth running when Codex finished normally and changed something.
            if (status === 'done' && changes?.length) {
              const verdict = await verifyChanges(
                projectPath,
                changes.map((c) => c.path)
              ).catch(() => ({ ok: null, summary: '' }))
              checks = verdict.summary
              checksOk = verdict.ok
            }
            if (handoffId !== undefined) {
              attempt(() =>
                finishHandoff(memoryDb(), handoffId, {
                  status,
                  report: [report, checks].filter(Boolean).join('\n\n'),
                  files: changes?.map((c) => c.path) ?? null
                })
              )
            }
            return { changes, diff, checks, checksOk }
          }

          try {
            const images = (request?.images ?? []).filter((p) => existsSync(p))
            const context = memory ? attempt(() => handoffContext(memory.projectId, args.prompt, request)) : undefined
            const run = (resumeThreadId?: string): Promise<CodexExecResult> =>
              runCodexExec(
                {
                  prompt: args.prompt,
                  cwd: projectPath,
                  timeoutMs: args.timeoutMs ?? 300_000,
                  unsandboxed,
                  model: getSettings().codexModel ?? undefined,
                  images,
                  resumeThreadId,
                  // Read fresh at hand-off time: Claude may have just saved some.
                  memory: memory
                    ? {
                        ...memory,
                        keyFacts: currentKeyFacts(memory.projectId),
                        context,
                        autoMemory: getSettings().autoMemory
                      }
                    : undefined,
                  signal
                },
                onProgress
              )

            // Pick up this request's earlier Codex session, if it's still valid.
            const thread = codexThread?.get()
            const resumeId = thread && thread.unsandboxed === unsandboxed ? thread.id : undefined
            let result = await run(resumeId)
            let continued = !!resumeId
            if (resumeId && result.exitCode !== 0 && !result.finalMessage) {
              // The old session couldn't be resumed: start a new one instead.
              codexThread?.set(undefined)
              recordUsage(projectId, 'handoff', 'codex', countsFromCodexEvents(result.events))
              result = await run(undefined)
              continued = false
            }
            if (result.threadId && result.exitCode === 0) codexThread?.set({ id: result.threadId, unsandboxed })
            recordUsage(projectId, 'handoff', 'codex', countsFromCodexEvents(result.events))

            const full = `${continued ? '(Continued the earlier Codex session from this request.)\n' : ''}${
              result.finalMessage || '(Codex finished with no final message.)'
            }`
            const status = result.exitCode === 0 ? 'done' : 'error'
            const { changes, diff, checks, checksOk } = await outcome(status, full)

            const summary =
              full.length > SUMMARY_CHARS
                ? `${full.slice(0, SUMMARY_CHARS)}\n… (shortened; the full report is saved: handoffs tool, id ${handoffId ?? '?'})`
                : full
            const parts = [`Hand-off${handoffId !== undefined ? ` #${handoffId}` : ''}`]
            if (changes) parts.push(changes.length ? `files changed: ${describeChanges(changes)}` : 'no files changed')
            const lines = [summary, `[${parts.join(' · ')}]`]
            if (checks) lines.push(`[${checks}]`)
            if (diff.trim()) {
              lines.push(
                diff.length <= DIFF_INLINE_CHARS
                  ? `Diff:\n${diff.trim()}`
                  : `(The diff is ${diff.length} characters, so it isn't included; read the files you need to review.)`
              )
            }
            return {
              content: [{ type: 'text' as const, text: lines.join('\n\n') }],
              isError: result.exitCode !== 0 || checksOk === false
            }
          } catch (err) {
            const message = (err as Error).message
            await outcome(signal?.aborted ? 'stopped' : 'error', message).catch(() => undefined)
            return {
              content: [{ type: 'text' as const, text: `Codex delegation failed: ${message}` }],
              isError: true
            }
          }
        }
      )
    ]
  })
}
