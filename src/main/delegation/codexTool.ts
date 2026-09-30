import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import * as z from 'zod/v4'
import { runCodexExec, type CodexExecArgs } from '../cli/codexExec'
import { getSettings } from '../settings/store'
import { memoryDb } from '../memory/paths'
import { keyFactsBlock } from '../memory/store'

export type DelegationProgressListener = (note: string) => void

function currentKeyFacts(projectId: string): string | undefined {
  try {
    return keyFactsBlock(memoryDb(), projectId)
  } catch {
    return undefined // memory unavailable: Codex can still search it
  }
}

export function createCodexDelegationServer(
  projectPath: string,
  onProgress: DelegationProgressListener,
  isGoNutzMode: () => boolean,
  memory?: NonNullable<CodexExecArgs['memory']>,
  /** Aborted when the user presses Stop. */
  getStopSignal?: () => AbortSignal
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: 'vibe_tools',
    version: '1.0.0',
    tools: [
      tool(
        'run_codex_subtask',
        'Delegate a scoped coding subtask to the Codex CLI (a separate AI coding agent) and return its result. Useful for getting a second implementation, a second opinion, or offloading an independent chunk of work.',
        {
          prompt: z.string().describe('The subtask instructions for Codex to carry out.'),
          timeoutMs: z
            .number()
            .optional()
            .describe('Optional timeout in milliseconds. Defaults to 5 minutes.')
        },
        async (args) => {
          try {
            const result = await runCodexExec(
              {
                prompt: args.prompt,
                cwd: projectPath,
                timeoutMs: args.timeoutMs ?? 300_000,
                unsandboxed: isGoNutzMode(),
                model: getSettings().codexModel ?? undefined,
                // Read fresh at hand-off time: Claude may have just saved some.
                memory: memory ? { ...memory, keyFacts: currentKeyFacts(memory.projectId) } : undefined,
                signal: getStopSignal?.()
              },
              onProgress
            )
            return {
              content: [
                {
                  type: 'text' as const,
                  text: result.finalMessage || '(Codex finished with no final message.)'
                }
              ],
              isError: result.exitCode !== 0
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Codex delegation failed: ${(err as Error).message}` }],
              isError: true
            }
          }
        }
      )
    ]
  })
}
