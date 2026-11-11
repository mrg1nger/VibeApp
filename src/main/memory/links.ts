import { readFileSync } from 'fs'
import { join } from 'path'
import { changesSince } from '../git/snapshots'
import { memoryDb } from './paths'
import { linkFactFiles, linkNamedFiles, listCodeFiles, namedFiles, noteFileChanges } from './store'

// Which files each fact is about, kept up to date from the app's side (store.ts keeps the
// links). The note-taker links what it saves to the files the request changed; any fact that
// names a mapped file is linked to it; and every request's changes are counted against the
// facts about those files, so a fact whose files changed a lot can be marked "may be out of date".

/** Lines in a project file now (0 if it can't be read). */
export function lineCount(projectPath: string, path: string): number {
  try {
    const text = readFileSync(join(projectPath, path), 'utf-8')
    return text ? text.split('\n').length : 0
  } catch {
    return 0
  }
}

/**
 * Counts what a request changed (since its snapshot) against the facts about those files.
 * Returns the files it changed that still exist. Never throws.
 */
export async function noteRequestChanges(projectId: string, projectPath: string, snapshot: string | undefined): Promise<string[]> {
  if (!snapshot) return []
  try {
    const { changes, gone, takenAt } = await changesSince(projectPath, snapshot)
    if (!changes.length && !gone.length) return []
    // A fact an agent saved or corrected during the request already describes the files after it.
    noteFileChanges(memoryDb(), projectId, changes, gone, takenAt)
    const deleted = new Set(gone)
    return changes.map((c) => c.path).filter((p) => !deleted.has(p))
  } catch (err) {
    console.warn('Counting the request\'s changes for memory failed:', (err as Error).message)
    return []
  }
}

/** Links a fact to the files it is about: those chosen (from the request's changes), and the mapped files it names. */
export function linkFact(projectId: string, projectPath: string, factId: string, text: string, chosen: string[], changed: string[]): void {
  try {
    const db = memoryDb()
    const mapped = listCodeFiles(db, projectId, 2000).map((f) => f.path)
    const allowed = new Set(changed)
    const paths = [...new Set([...chosen.map((p) => p.replace(/\\/g, '/')).filter((p) => allowed.has(p)), ...namedFiles(text, [...new Set([...mapped, ...changed])])])]
    if (paths.length) linkFactFiles(db, factId, paths.slice(0, 12).map((path) => ({ path, lines: lineCount(projectPath, path) })))
  } catch (err) {
    console.warn('Linking a fact to its files failed:', (err as Error).message)
  }
}

/** Links the project's facts to the mapped files they name (after the code map changes). Never throws. */
export function linkNamedFilesInProject(projectId: string, projectPath: string): void {
  try {
    const db = memoryDb()
    const paths = listCodeFiles(db, projectId, 2000).map((f) => f.path)
    linkNamedFiles(db, projectId, paths, (path) => lineCount(projectPath, path))
  } catch (err) {
    console.warn('Linking facts to the files they name failed:', (err as Error).message)
  }
}
