import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ModelOption } from '@shared/types'
import { resolveClaudeExecutable } from './claudeBinary'

let cached: ModelOption[] | undefined

/** Models the signed-in Claude account can use, as reported by Claude Code itself. */
export async function listClaudeModels(): Promise<ModelOption[]> {
  if (cached) return cached
  let release: () => void = () => {}
  const idle = new Promise<void>((resolve) => (release = resolve))
  // A prompt stream that never sends anything: enough to start Claude Code
  // and ask it for the model list without starting a conversation.
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await idle
  })()
  const q = query({ prompt, options: { pathToClaudeCodeExecutable: resolveClaudeExecutable() } })
  try {
    const models = await q.supportedModels()
    cached = models.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description }))
    return cached
  } finally {
    release()
    q.interrupt().catch(() => undefined)
  }
}
