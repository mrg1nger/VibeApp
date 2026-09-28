import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'fs'
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

export function appendUserMessage(projectId: string, text: string): void {
  const entry: TranscriptEntry = { direction: 'user', text }
  appendFileSync(transcriptPath(projectId), `${JSON.stringify(entry)}\n`, 'utf-8')
}

export function appendEvent(projectId: string, event: VibeEvent): void {
  const entry: TranscriptEntry = { direction: 'event', event }
  appendFileSync(transcriptPath(projectId), `${JSON.stringify(entry)}\n`, 'utf-8')
}

export function loadTranscript(projectId: string): TranscriptEntry[] {
  const file = transcriptPath(projectId)
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
  const entries: TranscriptEntry[] = []
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as TranscriptEntry)
    } catch {
      // Skip a corrupted line rather than failing the whole load.
    }
  }
  return entries
}
