import { memoryDb } from '../memory/paths'
import { logUsage, type UsageKind } from '../memory/store'

/** What one run cost, in the terms the usage log keeps. */
export interface TokenCounts {
  fresh: number
  cached: number
  output: number
  steps: number
  costUsd?: number
  model?: string
}

interface SdkResultLike {
  usage?: {
    input_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    output_tokens?: number
  }
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>
  total_cost_usd?: number
  num_turns?: number
}

/** Token counts from a Claude Agent SDK `result` message. */
export function countsFromSdkResult(result: SdkResultLike): TokenCounts {
  const u = result.usage ?? {}
  // The model that did most of the work (Claude Code also makes small side calls to Haiku).
  let model: string | undefined
  let most = -1
  for (const [name, m] of Object.entries(result.modelUsage ?? {})) {
    const total = (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0)
    if (total > most) {
      most = total
      model = name
    }
  }
  return {
    fresh: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    cached: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    steps: result.num_turns ?? 1,
    costUsd: result.total_cost_usd,
    model
  }
}

interface CodexEventLike {
  type?: string
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
}

/** Token counts from Codex's JSON events (one turn.completed per turn, summed). */
export function countsFromCodexEvents(events: CodexEventLike[]): TokenCounts {
  const total: TokenCounts = { fresh: 0, cached: 0, output: 0, steps: 0 }
  for (const e of events) {
    if (e.type !== 'turn.completed' || !e.usage) continue
    const cached = e.usage.cached_input_tokens ?? 0
    total.fresh += Math.max(0, (e.usage.input_tokens ?? 0) - cached)
    total.cached += cached
    total.output += e.usage.output_tokens ?? 0
    total.steps += 1
  }
  total.steps = Math.max(1, total.steps)
  return total
}

/** Writes a run to the usage log. Never throws: measuring must not break the work. */
export function recordUsage(
  projectId: string | undefined,
  kind: UsageKind,
  agent: 'claude' | 'codex',
  counts: TokenCounts
): void {
  try {
    logUsage(memoryDb(), { projectId, kind, agent, ...counts })
  } catch (err) {
    console.warn('Logging usage failed:', (err as Error).message)
  }
}
