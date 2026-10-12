import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'fs'
import * as z from 'zod/v4'
import { runCodexExec, type CodexExecArgs } from '../cli/codexExec'
import { getSettings } from '../settings/store'
import { memoryDb } from '../memory/paths'
import { finishHandoff, keyFactsBlock, startHandoff } from '../memory/store'
import { handoffContext } from '../memory/context'
import { changedFiles, takeSnapshot } from '../git/snapshots'

export type DelegationProgressListener = (note: string) => void

/** What the user asked for in this turn, in their own words, to pass along with a hand-off. */
export interface RequestContext {
  text: string
  /** Description of an element they pointed at in the preview. */
  element?: string
  /** Paths of images they attached (the originals). */
  images: string[]
}

/** Longest hand-off report returned to Claude; the full one is kept for the handoffs tool. */
const REPORT_CHARS = 6000

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

export function createCodexDelegationServer(
  projectPath: string,
  onProgress: DelegationProgressListener,
  isGoNutzMode: () => boolean,
  memory?: NonNullable<CodexExecArgs['memory']>,
  /** Aborted when the user presses Stop. */
  getStopSignal?: () => AbortSignal,
  getRequestContext?: () => RequestContext | undefined
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: 'vibe_tools',
    version: '1.0.0',
    tools: [
      tool(
        'run_codex_subtask',
        'Delegate a scoped coding subtask to the Codex CLI (a separate AI coding agent) and return its result. Useful for getting a second implementation, a second opinion, or offloading an independent chunk of work. Codex is automatically given the user\'s original request, the key facts, relevant memories and recent hand-offs, so the task only needs to say what to do, which files are involved, and what "done" looks like.',
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

          // Log it, and note which files change (snapshots before and after).
          const handoffId = projectId
            ? attempt(() => startHandoff(memoryDb(), projectId, 'codex', args.prompt, request?.text ?? null))
            : undefined
          const before = await takeSnapshot(projectPath, 'before hand-off').catch(() => undefined)

          const finish = async (
            status: 'done' | 'error' | 'stopped',
            report: string
          ): Promise<string[] | null> => {
            let files: string[] | null = null
            if (before) {
              const after = await takeSnapshot(projectPath, 'after hand-off').catch(() => undefined)
              if (after) files = await changedFiles(projectPath, before, after).catch(() => null)
            }
            if (handoffId !== undefined) attempt(() => finishHandoff(memoryDb(), handoffId, { status, report, files }))
            return files
          }

          try {
            const images = (request?.images ?? []).filter((p) => existsSync(p))
            const result = await runCodexExec(
              {
                prompt: args.prompt,
                cwd: projectPath,
                timeoutMs: args.timeoutMs ?? 300_000,
                unsandboxed: isGoNutzMode(),
                model: getSettings().codexModel ?? undefined,
                images,
                // Read fresh at hand-off time: Claude may have just saved some.
                memory: memory
                  ? {
                      ...memory,
                      keyFacts: currentKeyFacts(memory.projectId),
                      context: attempt(() => handoffContext(memory.projectId, args.prompt, request))
                    }
                  : undefined,
                signal
              },
              onProgress
            )
            const full = result.finalMessage || '(Codex finished with no final message.)'
            const files = await finish(result.exitCode === 0 ? 'done' : 'error', full)
            const shown =
              full.length > REPORT_CHARS
                ? `${full.slice(0, REPORT_CHARS)}\n… (shortened; the full report is saved: use the handoffs tool)`
                : full
            const filesLine =
              files === null
                ? ''
                : files.length
                  ? `files changed: ${files.slice(0, 15).join(', ')}${files.length > 15 ? ` and ${files.length - 15} more` : ''}`
                  : 'no files changed'
            const footer = `\n\n[Hand-off${handoffId !== undefined ? ` #${handoffId}` : ''}${filesLine ? ` · ${filesLine}` : ''}]`
            return {
              content: [{ type: 'text' as const, text: shown + footer }],
              isError: result.exitCode !== 0
            }
          } catch (err) {
            const message = (err as Error).message
            await finish(signal?.aborted ? 'stopped' : 'error', message).catch(() => undefined)
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
