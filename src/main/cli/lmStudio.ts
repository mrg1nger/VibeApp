import { getSettings } from '../settings/store'
import type { TokenCounts } from '../usage/tokens'
import type { LmStudioModel, LmStudioStatus } from '@shared/types'

// LM Studio: a model running on the user's own computer, reached through the
// local server LM Studio starts (Developer → Start Server, port 1234 by default).
// It speaks the OpenAI chat API, so VibeApp's background jobs (short text in,
// JSON out, no tools) can run there for free instead of on Haiku or ClinePass.

export const LM_STUDIO_DEFAULT_URL = 'http://localhost:1234'

/** The server's address without a trailing slash or /v1 (people paste either). */
export function lmStudioBase(url?: string | null): string {
  const raw = (url ?? '').trim() || LM_STUDIO_DEFAULT_URL
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  return withScheme.replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/api\/v0$/i, '')
}

interface V0Model {
  id: string
  type?: string
  state?: string
  loaded_context_length?: number
  max_context_length?: number
}

/** The chat models LM Studio has (not its embedding models), loaded ones first. */
export function chatModelsFrom(v0: V0Model[] | undefined, v1: { id: string }[] | undefined): LmStudioModel[] {
  const models: LmStudioModel[] = v0
    ? v0
        .filter((m) => m.type !== 'embeddings')
        .map((m) => ({ id: m.id, loaded: m.state === 'loaded', contextLength: m.loaded_context_length ?? m.max_context_length }))
    : (v1 ?? []).filter((m) => !/embed/i.test(m.id)).map((m) => ({ id: m.id, loaded: false }))
  return models.sort((a, b) => Number(b.loaded) - Number(a.loaded) || a.id.localeCompare(b.id))
}

/** The model a job uses: the chosen one, otherwise the one loaded now, otherwise the first (LM Studio loads it on demand). */
export function pickModel(models: LmStudioModel[], chosen: string | null): string | undefined {
  if (chosen) return chosen
  return (models.find((m) => m.loaded) ?? models[0])?.id
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

/** Whether LM Studio's server answers at this address, and the chat models it has. Never throws. */
export async function lmStudioStatus(url?: string | null): Promise<LmStudioStatus> {
  const base = lmStudioBase(url ?? getSettings().lmStudioUrl)
  try {
    // LM Studio's own list says which models are loaded; the OpenAI-style one is the fallback.
    let v0: V0Model[] | undefined
    let v1: { id: string }[] | undefined
    try {
      v0 = ((await getJson(`${base}/api/v0/models`, 3000)) as { data?: V0Model[] }).data
    } catch {
      v1 = ((await getJson(`${base}/v1/models`, 3000)) as { data?: { id: string }[] }).data
    }
    const models = chatModelsFrom(v0, v1)
    return { running: true, url: base, models }
  } catch (err) {
    const message = (err as Error).name === 'TimeoutError' ? 'no answer within 3 s' : (err as Error).message
    return { running: false, url: base, models: [], error: `LM Studio's server isn't answering at ${base} (${message}).` }
  }
}

// Background jobs ask whether LM Studio is there before each run; the answer is
// kept briefly so a burst of jobs doesn't probe the server every time.
let cached: { key: string; at: number; status: LmStudioStatus } | undefined

/** Turned on in Settings, the server is answering, and there's a chat model to use. */
export async function lmStudioReady(): Promise<boolean> {
  const settings = getSettings()
  if (!settings.lmStudioHelpers) return false
  const key = lmStudioBase(settings.lmStudioUrl)
  const fresh = cached && cached.key === key && Date.now() - cached.at < (cached.status.running ? 30_000 : 15_000)
  if (!fresh) cached = { key, at: Date.now(), status: await lmStudioStatus(key) }
  return cached!.status.running && !!pickModel(cached!.status.models, settings.lmStudioModel)
}

/** Forget the last look at the server (after a failure or a settings change). */
export function forgetLmStudioStatus(): void {
  cached = undefined
}

export interface LmStudioRun {
  system: string
  prompt: string
  /** JSON Schema the answer must follow (LM Studio holds the model to it). */
  schema?: Record<string, unknown>
  /** Let a thinking model think first; off by default (about ten times faster). */
  thinking?: boolean
  model?: string
  timeoutMs?: number
}

export interface LmStudioResult {
  text: string
  model: string
  usage: TokenCounts
}

interface ChatResponse {
  model?: string
  choices?: { message?: { content?: string | null }; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
  error?: { message?: string } | string
}

/** Token counts from an OpenAI-style `usage` block. */
export function countsFromChatUsage(usage: ChatResponse['usage'], model?: string): TokenCounts {
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0
  return {
    fresh: Math.max(0, (usage?.prompt_tokens ?? 0) - cachedTokens),
    cached: cachedTokens,
    output: usage?.completion_tokens ?? 0,
    steps: 1,
    model
  }
}

/** One request to LM Studio. Throws with a reason when it can't answer. */
export async function runLmStudio(run: LmStudioRun): Promise<LmStudioResult> {
  const settings = getSettings()
  const base = lmStudioBase(settings.lmStudioUrl)
  let model = run.model ?? settings.lmStudioModel ?? undefined
  if (!model) {
    const status = await lmStudioStatus(base)
    if (!status.running) throw new Error(status.error)
    model = pickModel(status.models, null)
    if (!model) throw new Error('LM Studio has no chat model downloaded.')
  }
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: run.system },
      { role: 'user', content: run.prompt }
    ],
    temperature: 0.2,
    stream: false,
    ...(run.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: run.schema } } } : {}),
    // Thinking models (Qwen3 and the like) spend most of their time thinking; "none" skips it.
    ...(run.thinking ? {} : { reasoning_effort: 'none' })
  }
  const send = async (payload: Record<string, unknown>): Promise<{ status: number; json: ChatResponse }> => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(run.timeoutMs ?? 4 * 60_000)
    })
    const text = await res.text()
    let json: ChatResponse
    try {
      json = JSON.parse(text) as ChatResponse
    } catch {
      json = { error: text.slice(0, 300) || res.statusText }
    }
    return { status: res.status, json }
  }
  let reply: Awaited<ReturnType<typeof send>>
  try {
    reply = await send(body)
    // An older LM Studio or another server may not know reasoning_effort: try once without it.
    if (reply.status === 400 && 'reasoning_effort' in body && /reasoning/i.test(errorText(reply.json))) {
      const { reasoning_effort: _dropped, ...rest } = body
      reply = await send(rest)
    }
  } catch (err) {
    forgetLmStudioStatus()
    if ((err as Error).name === 'TimeoutError') throw new Error('LM Studio took too long to answer.')
    throw new Error(`Couldn't reach LM Studio at ${base} (${(err as Error).message}).`)
  }
  const usage = countsFromChatUsage(reply.json.usage, reply.json.model ?? model)
  if (reply.status >= 400 || reply.json.error) {
    throw Object.assign(new Error(`LM Studio refused the job: ${errorText(reply.json) || `HTTP ${reply.status}`}`), { usage })
  }
  const choice = reply.json.choices?.[0]
  const text = (choice?.message?.content ?? '').trim()
  if (!text) {
    const why = choice?.finish_reason === 'length' ? ' (it ran out of room: load the model with a longer context)' : ''
    throw Object.assign(new Error(`LM Studio returned nothing${why}.`), { usage })
  }
  return { text, model: reply.json.model ?? model, usage }
}

function errorText(json: ChatResponse): string {
  return typeof json.error === 'string' ? json.error : (json.error?.message ?? '')
}

/** A tiny live run for Settings: is the server up and does the model answer? */
export async function checkLmStudio(): Promise<{ ok: boolean; message: string; model?: string; seconds: number }> {
  const started = Date.now()
  const seconds = (): number => Math.round((Date.now() - started) / 100) / 10
  forgetLmStudioStatus()
  try {
    const result = await runLmStudio({
      system: 'You are a connection check. Reply with exactly the word asked for.',
      prompt: 'Reply with the single word READY.',
      timeoutMs: 3 * 60_000
    })
    // The first request after LM Studio starts loads the model, which can take a while.
    return { ok: true, message: `LM Studio answered in ${seconds()} s (${result.model}).`, model: result.model, seconds: seconds() }
  } catch (err) {
    return { ok: false, message: (err as Error).message, seconds: seconds() }
  }
}
