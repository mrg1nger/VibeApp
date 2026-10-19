import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import * as z from 'zod/v4'
import { runCodexExec, type CodexExecArgs, type CodexExecResult } from '../cli/codexExec'
import { getSettings } from '../settings/store'
import { memoryDb } from '../memory/paths'
import { codeSummariesFor, finishHandoff, keyFactsBlock, reviewConventions, startHandoff } from '../memory/store'
import { digestDiff } from './diffDigest'
import { briefBlock } from '../memory/brief'
import { handoffContext } from '../memory/context'
import { changeStats, diffSnapshots, takeSnapshot, type FileChange } from '../git/snapshots'
import { verifyChanges } from '../review/checks'
import { countsFromCodexEvents, recordUsage } from '../usage/tokens'
import type { DelegationActivity } from '@shared/types'
import type { AgentInstallRequest } from '../extensions/install'

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

/** How long a hand-off may run before it is stopped (real tasks on a big project take a while). */
const HANDOFF_TIMEOUT_MS = 15 * 60_000

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
  codexThread?: { get: () => CodexThread | undefined; set: (thread: CodexThread | undefined) => void },
  /** Each step Codex takes, for the live feed in the chat. */
  onActivity?: (activity: DelegationActivity) => void,
  /** Building an approved plan: Claude reports each step starting and finishing. */
  onPlanProgress?: (step: number, status: 'doing' | 'done') => void,
  /** Registers an MCP server the agent built as an extension (asks the user first). */
  installExtension?: (req: AgentInstallRequest) => Promise<{ ok: boolean; message: string }>
): ReturnType<typeof createSdkMcpServer> {
  // Hand-offs share the project folder and the request's Codex session, and each one's
  // "files changed" comes from before/after snapshots, so two at once would edit the same
  // files and report each other's changes. Claude may ask for several at once; run them in turn.
  let queue: Promise<unknown> = Promise.resolve()
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work)
    queue = run.catch(() => undefined)
    return run
  }

  return createSdkMcpServer({
    name: 'vibe_tools',
    version: '1.0.0',
    tools: [
      tool(
        'plan_progress',
        'While building a plan the user approved: report that a step (by its number in the plan) has started ("doing") or is finished ("done"). The user sees the plan as a checklist that ticks off as you go.',
        {
          step: z.number().int().min(1).describe('The step number in the approved plan.'),
          status: z.enum(['doing', 'done'])
        },
        async (args) => {
          // The end-to-end test switches the tool off to check VibeApp's backups (to-do list, honest finish).
          if (process.env.VIBEAPP_TEST_HOOKS === '1' && existsSync(join(app.getPath('userData'), 'test-no-plan-progress'))) {
            return { content: [{ type: 'text' as const, text: 'Progress reporting is not available right now; carry on.' }] }
          }
          onPlanProgress?.(args.step, args.status)
          return { content: [{ type: 'text' as const, text: `Step ${args.step}: ${args.status}.` }] }
        }
      ),
      tool(
        'install_extension',
        "Install an MCP server (a set of tools) for the user, available to you and to Codex in every project, switchable in VibeApp's Extensions screen. Use it after you have built an MCP server in the project, or when the user asks to add one. The user is asked to confirm and the server is started once to check it works. Put the server's code in a project folder and pass it as sourceDir: the folder is copied into VibeApp's data so it outlives the project, and \"{{dir}}\" in args becomes that copy's path (for example command \"node\", args [\"{{dir}}/index.js\"]). If it needs API keys, list their names in keys and read them from environment variables; never ask the user to paste a key into the chat.",
        {
          name: z.string().describe('Short human name, e.g. "Weather lookup".'),
          description: z.string().optional().describe('One sentence on what the tools do.'),
          command: z.string().describe('Program that runs the server, e.g. node, npx, python.'),
          args: z.array(z.string()).describe('Arguments; {{dir}} stands for the copied folder.'),
          sourceDir: z.string().optional().describe('Folder inside the project with the server code (relative or absolute).'),
          instructions: z.string().optional().describe('One or two sentences telling the agents when to use these tools.'),
          keys: z.array(z.string()).optional().describe('Names of environment variables it needs (e.g. WEATHER_API_KEY).')
        },
        async (args) => {
          if (!installExtension) {
            return { content: [{ type: 'text' as const, text: 'Installing extensions is not available here.' }], isError: true }
          }
          try {
            const result = await installExtension(args)
            return { content: [{ type: 'text' as const, text: result.message }], isError: !result.ok }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Install failed: ${(err as Error).message}` }],
              isError: true
            }
          }
        }
      ),
      tool(
        'run_codex_subtask',
        "Delegate a scoped coding subtask to the Codex CLI (a separate AI coding agent) and return its result. Useful for getting a second implementation, a second opinion, or offloading an independent chunk of work. Codex is automatically given the user's original request, the key facts, relevant memories and recent hand-offs, and several hand-offs in one request continue the same Codex session, so a task only needs to say what to do, which files are involved, and what \"done\" looks like. The result is a short summary, the files changed (with a small diff) and the outcome of automatic checks (script syntax, JSON, the project's npm test); the full report is available from the handoffs tool. Hand-offs run one at a time (they share the project folder), so asking for several at once doesn't make them faster.",
        {
          prompt: z.string().describe('The subtask instructions for Codex to carry out.'),
          timeoutMs: z
            .number()
            .optional()
            .describe('Optional timeout in milliseconds. Defaults to 15 minutes.')
        },
        (args) => oneAtATime(async () => {
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
                  timeoutMs: args.timeoutMs ?? HANDOFF_TIMEOUT_MS,
                  unsandboxed,
                  model: getSettings().codexModel ?? undefined,
                  effort: getSettings().codexEffort ?? undefined,
                  images,
                  resumeThreadId,
                  // Read fresh at hand-off time: Claude may have just saved some.
                  memory: memory
                    ? {
                        ...memory,
                        keyFacts: currentKeyFacts(memory.projectId),
                        brief: attempt(() => briefBlock(memory.projectId)),
                        context,
                        autoMemory: getSettings().autoMemory
                      }
                    : undefined,
                  signal
                },
                onProgress,
                onActivity
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
              if (diff.length <= DIFF_INLINE_CHARS) {
                lines.push(`Diff:\n${diff.trim()}`)
              } else {
                // Too big to hand back whole: a digest built from the code map and the request.
                const summaries =
                  (projectId && changes
                    ? attempt(() =>
                        codeSummariesFor(
                          memoryDb(),
                          projectId,
                          changes.map((c) => c.path)
                        )
                      )
                    : undefined) ?? new Map<string, string>()
                lines.push(digestDiff(diff, changes ?? [], `${request?.text ?? ''} ${args.prompt}`, summaries))
              }
            }
            // Remembered conventions that bear on this change, so the review checks against them.
            if (projectId && changes?.length) {
              const text = [request?.text, args.prompt, ...changes.map((c) => c.path)].filter(Boolean).join(' ')
              const rules = attempt(() => reviewConventions(memoryDb(), projectId, text))
              if (rules?.length) {
                lines.push(
                  `[Remembered conventions that apply here; check the change against them:\n${rules
                    .map((r) => `- ${r.text}`)
                    .join('\n')}]`
                )
              }
            }
            return {
              content: [{ type: 'text' as const, text: lines.join('\n\n') }],
              isError: result.exitCode !== 0 || checksOk === false
            }
          } catch (err) {
            const message = (err as Error).message
            const partial = await outcome(signal?.aborted ? 'stopped' : 'error', message).catch(() => undefined)
            // Codex may have changed files before it failed or was stopped; say which, so
            // nobody assumes the project is as it was.
            const touched = partial?.changes?.length
              ? `
[Files Codex changed before it stopped: ${describeChanges(partial.changes)}. Check them before continuing; they may be half-done.]`
              : ''
            return {
              content: [{ type: 'text' as const, text: `Codex delegation failed: ${message}${touched}` }],
              isError: true
            }
          }
        })
      )
    ]
  })
}
