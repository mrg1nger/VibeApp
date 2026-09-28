import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import * as z from 'zod/v4'
import { runCodexExec } from '../cli/codexExec'

export type DelegationProgressListener = (note: string) => void

export function createCodexDelegationServer(
  projectPath: string,
  onProgress: DelegationProgressListener
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
              { prompt: args.prompt, cwd: projectPath, timeoutMs: args.timeoutMs ?? 300_000 },
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
