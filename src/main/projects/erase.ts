import { app } from 'electron'
import { rmSync } from 'fs'
import { join } from 'path'
import { memoryDb } from '../memory/paths'
import { eraseProjectFromMemory } from '../memory/store'
import { disposeSession } from '../orchestrator/session'
import { findPreview } from '../preview/preview'

/**
 * Deletes everything VibeApp keeps for a project: chat history, memory,
 * hand-off log, code map, saved secrets and attached images. The project's
 * own folder is never touched.
 */
export function eraseProjectData(projectId: string): string[] {
  // The id names files on disk, so refuse anything that isn't one of ours.
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('Invalid project id.')
  const erased: string[] = []
  const data = app.getPath('userData')
  const attempt = (what: string, work: () => void): void => {
    try {
      work()
      erased.push(what)
    } catch (err) {
      console.warn(`Erasing ${what} failed:`, (err as Error).message)
    }
  }

  attempt('running chat', () => disposeSession(projectId))
  attempt('preview', () => findPreview(projectId)?.stop(true))
  attempt('memory and history', () => eraseProjectFromMemory(memoryDb(), projectId))
  attempt('chat log', () => rmSync(join(data, 'transcripts', `${projectId}.jsonl`), { force: true }))
  attempt('attached images', () => rmSync(join(data, 'attachments', projectId), { recursive: true, force: true }))
  attempt('secrets', () => rmSync(join(data, 'secrets', `${projectId}.bin`), { force: true }))
  attempt('old memory file', () => rmSync(join(data, 'memory-projects', `${projectId}.json`), { force: true }))
  return erased
}
