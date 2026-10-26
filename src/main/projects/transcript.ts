import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, appendFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { TranscriptEntry, VibeEvent } from '@shared/types'

function transcriptDir(): string {
  const dir = join(app.getPath('userData'), 'transcripts')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function transcriptPath(projectId: string): string {
  return join(transcriptDir(), `${projectId}.jsonl`)
}

/**
 * The longest a tool's full output, or a long tool argument (a whole file
 * being written, say), is kept in the chat log. The chat only ever shows a
 * one-line summary of them, but keeping them whole made a big project's log
 * 95 MB, nine tenths of it tool output, re-read on every open.
 */
const KEEP_CHARS = 2000

function shorten(text: string): string {
  return text.length > KEEP_CHARS ? `${text.slice(0, KEEP_CHARS)}… (${text.length} characters, shortened)` : text
}

/** The event as it's kept in the log: tool output and long arguments shortened, everything shown kept. */
export function slimEvent(event: VibeEvent): VibeEvent {
  if (event.type === 'tool_result' && event.raw !== undefined && event.raw !== null) {
    const text = typeof event.raw === 'string' ? event.raw : JSON.stringify(event.raw)
    return text.length > KEEP_CHARS ? { ...event, raw: shorten(text) } : event
  }
  if (event.type === 'tool_call' && event.input && typeof event.input === 'object' && !Array.isArray(event.input)) {
    let changed = false
    const input = Object.fromEntries(
      Object.entries(event.input as Record<string, unknown>).map(([key, value]) => {
        if (typeof value === 'string' && value.length > KEEP_CHARS) {
          changed = true
          return [key, shorten(value)]
        }
        return [key, value]
      })
    )
    return changed ? { ...event, input } : event
  }
  return event
}

export function appendUserMessage(
  projectId: string,
  text: string,
  extras: { snapshot?: string; attachment?: string; images?: string[] } = {}
): void {
  const entry: TranscriptEntry = { direction: 'user', text, ...extras }
  appendFileSync(transcriptPath(projectId), `${JSON.stringify(entry)}\n`, 'utf-8')
}

export function appendEvent(projectId: string, event: VibeEvent): void {
  const entry: TranscriptEntry = { direction: 'event', event: slimEvent(event) }
  appendFileSync(transcriptPath(projectId), `${JSON.stringify(entry)}\n`, 'utf-8')
}

/** A log this big that slimming shrinks a lot is rewritten slimmed, once (logs from before slimming). */
const SLIM_FILES_OVER_BYTES = 5_000_000

export function loadTranscript(projectId: string): TranscriptEntry[] {
  const file = transcriptPath(projectId)
  if (!existsSync(file)) return []
  const raw = readFileSync(file, 'utf-8')
  const lines = raw.split('\n').filter(Boolean)
  const entries: TranscriptEntry[] = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as TranscriptEntry
      entries.push(entry.direction === 'event' && entry.event ? { ...entry, event: slimEvent(entry.event) } : entry)
    } catch {
      // Skip a corrupted line rather than failing the whole load.
    }
  }
  if (raw.length > SLIM_FILES_OVER_BYTES) {
    try {
      const slim = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`
      // Written whole, then swapped in, so a crash part-way leaves the old log intact.
      if (slim.length < raw.length * 0.7 && statSync(file).size === Buffer.byteLength(raw)) {
        const tmp = `${file}.slim`
        writeFileSync(tmp, slim, 'utf-8')
        renameSync(tmp, file)
      }
    } catch (err) {
      console.warn('Slimming the chat log failed (it still works as it is):', (err as Error).message)
    }
  }
  return entries
}

/**
 * The end of the log: the last `requests` user messages and everything after
 * them (all of it when `requests` is 0), and how many earlier messages were
 * left out. What the chat loads when it opens, so a long project opens fast,
 * and a phone doesn't download the whole history every time.
 */
export function loadRecentTranscript(projectId: string, requests: number): { entries: TranscriptEntry[]; earlier: number } {
  const all = loadTranscript(projectId)
  if (!requests || requests <= 0) return { entries: all, earlier: 0 }
  // Start at the oldest request kept, not just after the newest one left out: otherwise the
  // chat opened with the left-out request's answer and no question above it.
  let seen = 0
  let start = 0
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].direction !== 'user') continue
    if (++seen > requests) {
      return { entries: all.slice(start), earlier: all.slice(0, start).filter((e) => e.direction === 'user').length }
    }
    start = i
  }
  return { entries: all, earlier: 0 }
}
