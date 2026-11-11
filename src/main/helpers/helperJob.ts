import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveClaudeExecutable } from '../cli/claudeBinary'
import { clineUnavailable, resolveClineLaunch, runCline } from '../cli/clineExec'
import { clineModelFor } from '../cli/clineAcp'
import { getSettings } from '../settings/store'
import { countsFromSdkResult, recordUsage } from '../usage/tokens'
import { claudeHelpersAllowed } from '../usage/usage'
import type { UsageKind } from '../memory/store'

// VibeApp's background jobs (saving memory, the tidy-up, the project brief,
// file summaries, a conversation summary for a fresh session): short,
// repetitive text jobs with no tools. They ran on Haiku, about 12% of
// Claude's plan on a real install; with Cline set up they run on the user's
// ClinePass plan instead, and fall back to Haiku if Cline can't do one.

export interface HelperJob {
  kind: Extract<UsageKind, 'scribe' | 'tidy' | 'brief' | 'codemap' | 'summary'>
  projectId?: string
  prompt: string
  /** JSON Schema the answer must follow; the answer is then in `structured`. */
  schema?: JsonSchema
  /** Haiku's turn limit (structured output takes an extra turn). */
  maxTurns?: number
  /** Let Haiku think first (the tidy-up does). */
  thinking?: boolean
}

export interface HelperResult {
  text: string
  structured?: unknown
  by: 'cline' | 'haiku'
}

export interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  additionalProperties?: boolean
  description?: string
}

const CLINE_SYSTEM =
  'You are a careful assistant inside a coding app, doing one background job. You have no tools and need none: everything you need is in the message. Answer with exactly what the job asks for and nothing else.'

/** Whether a background job can run at all right now (Cline is set up, or Claude has room). */
export async function helpersAllowed(): Promise<boolean> {
  return (await clineReady()) || claudeHelpersAllowed()
}

async function clineReady(): Promise<boolean> {
  return getSettings().clineHelpers && !clineUnavailable() && !!(await resolveClineLaunch())
}

/** Unit tests answer background jobs themselves (no model, no usage). */
let answerForTests: ((job: HelperJob) => Promise<HelperResult>) | undefined

export function setHelperJobForTests(answer: ((job: HelperJob) => Promise<HelperResult>) | undefined): void {
  answerForTests = answer
}

/** Runs one background job: on Cline when it's set up, otherwise (or if Cline fails) on Haiku. */
export async function runHelperJob(job: HelperJob): Promise<HelperResult> {
  if (answerForTests) return answerForTests(job)
  if (await clineReady()) {
    try {
      return await onCline(job)
    } catch (err) {
      console.warn(`Background job (${job.kind}) on Cline failed, using Haiku instead:`, (err as Error).message)
      if (!claudeHelpersAllowed()) throw err
    }
  }
  return onHaiku(job)
}

async function onCline(job: HelperJob): Promise<HelperResult> {
  const cwd = mkdtempSync(join(tmpdir(), `vibeapp-${job.kind}-`))
  try {
    const prompt = job.schema
      ? `${job.prompt}\n\nAnswer with ONLY a JSON object (no code fence, no other text) that follows this JSON Schema exactly, with every required field:\n${JSON.stringify(job.schema)}`
      : job.prompt
    const result = await runCline({
      prompt,
      mode: 'helper',
      cwd,
      model: await clineModelFor('helper'),
      thinking: 'none',
      system: CLINE_SYSTEM,
      timeoutMs: 4 * 60_000
    })
    recordUsage(job.projectId, job.kind, 'cline', result.usage)
    if (!result.ok) throw new Error(result.error ?? 'Cline failed.')
    if (!job.schema) {
      if (!result.text.trim()) throw new Error('Cline returned nothing.')
      return { text: result.text.trim(), by: 'cline' }
    }
    const raw = extractJson(result.text)
    const structured = raw === undefined ? undefined : fillEmptyLists(raw, job.schema)
    const problem = structured === undefined ? 'the answer had no JSON in it' : schemaProblem(structured, job.schema)
    if (problem) throw new Error(`Cline's answer didn't follow the format (${problem}).`)
    return { text: result.text, structured, by: 'cline' }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function onHaiku(job: HelperJob): Promise<HelperResult> {
  const cwd = mkdtempSync(join(tmpdir(), `vibeapp-${job.kind}-`))
  const session = query({
    prompt: job.prompt,
    options: {
      cwd,
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      model: 'haiku',
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      settings: { disableClaudeAiConnectors: true },
      ...(job.thinking ? {} : { thinking: { type: 'disabled' as const } }),
      maxTurns: job.maxTurns ?? (job.schema ? 3 : 2),
      ...(job.schema ? { outputFormat: { type: 'json_schema' as const, schema: job.schema as Record<string, unknown> } } : {})
    }
  })
  for await (const message of session) {
    if (message.type !== 'result') continue
    recordUsage(job.projectId, job.kind, 'claude', countsFromSdkResult(message as Parameters<typeof countsFromSdkResult>[0]))
    // A refusal (e.g. the plan limit) also arrives as "success", flagged is_error.
    if (message.subtype !== 'success' || (message as { is_error?: boolean }).is_error) {
      throw new Error(`The ${job.kind} job failed (${message.subtype}).`)
    }
    if (job.schema && !message.structured_output) throw new Error(`The ${job.kind} job returned no structured answer.`)
    return { text: String(message.result ?? '').trim(), structured: message.structured_output, by: 'haiku' }
  }
  throw new Error(`The ${job.kind} job ended without a result.`)
}

/** The JSON object in a model's answer (fenced or not), or undefined. */
export function extractJson(text: string): unknown {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  for (const candidate of [unfenced, unfenced.slice(unfenced.indexOf('{'), unfenced.lastIndexOf('}') + 1)]) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next shape
    }
  }
  return undefined
}

/**
 * Fills in lists the answer left out as empty ("add" missing means nothing to add).
 * Seen with cline-pass/qwen3.8-max, which drops empty lists now and then; anything
 * else missing is still a problem.
 */
export function fillEmptyLists(value: unknown, schema: JsonSchema): unknown {
  if (schema.type !== 'object' || typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const record = { ...(value as Record<string, unknown>) }
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    if (!(key in record) && sub.type === 'array') record[key] = []
    else if (key in record) record[key] = fillEmptyLists(record[key], sub)
  }
  return record
}

/** What's wrong with a value against the (simple) schemas VibeApp uses, or null if it fits. */
export function schemaProblem(value: unknown, schema: JsonSchema, path = 'answer'): string | null {
  if (schema.enum && !schema.enum.includes(value)) return `${path} isn't one of ${schema.enum.join(', ')}`
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} isn't an object`
      const record = value as Record<string, unknown>
      for (const key of schema.required ?? []) if (!(key in record)) return `${path}.${key} is missing`
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (key in record) {
          const problem = schemaProblem(record[key], sub, `${path}.${key}`)
          if (problem) return problem
        }
      }
      return null
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path} isn't a list`
      for (let i = 0; i < value.length; i++) {
        const problem = schema.items ? schemaProblem(value[i], schema.items, `${path}[${i}]`) : null
        if (problem) return problem
      }
      return null
    }
    case 'string':
      return typeof value === 'string' ? null : `${path} isn't text`
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} isn't true/false`
    case 'number':
    case 'integer':
      return typeof value === 'number' ? null : `${path} isn't a number`
    default:
      return null
  }
}
