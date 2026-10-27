import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import type { BackupInfo } from '@shared/types'
import { memoryDb } from '../memory/paths'
import { getSettings, updateSettings } from '../settings/store'

// Backups of VibeApp's own data: the projects' memory, chat history, notes
// and to-dos, settings, secrets, deploy recipes, extensions and themes. The
// code is in git; this is what would be lost with the computer's disk. Each
// backup is a plain folder (easy to copy to a USB stick or another PC), made
// nightly, the newest few kept.

const PREFIX = 'VibeApp backup '
/** What's copied (when present). Remote access pairings and its certificate stay with this computer. */
const FILES = ['settings.json', 'projects.json', 'extensions.json', 'memory-global.json', 'schedules.json']
const FOLDERS = ['transcripts', 'secrets', 'talk', 'themes', 'deploy', 'extensions', 'attachments', 'memory-projects']

const userData = (): string => app.getPath('userData')

export function defaultBackupDir(): string {
  // A test copy of VibeApp (its own data folder) keeps its backups there too, never in the user's Documents.
  if (process.env.VIBEAPP_USER_DATA) return join(userData(), 'backups')
  return join(app.getPath('documents'), 'VibeApp Backups')
}

export function backupDir(): string {
  return getSettings().backupDir || defaultBackupDir()
}

function stamp(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
}

function folderSize(path: string): number {
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, entry.name)
    total += entry.isDirectory() ? folderSize(p) : statSync(p).size
  }
  return total
}

let backingUp = false

/** Makes a backup now, into `into` (a folder chosen for an export) or the backup folder. */
export function backupNow(reason: 'nightly' | 'manual' | 'before restore' | 'export', into?: string): BackupInfo {
  if (backingUp) throw new Error('A backup is already being made.')
  backingUp = true
  const parent = into || backupDir()
  const dest = join(parent, `${PREFIX}${stamp()}${reason === 'before restore' ? ' (before restore)' : ''}`)
  try {
    mkdirSync(dest, { recursive: true })
    // A consistent copy of the live database (it's in use, and has a write-ahead log beside it).
    const target = join(dest, 'memory.db').replace(/'/g, "''")
    memoryDb().exec(`VACUUM INTO '${target}'`)
    for (const name of FILES) {
      const from = join(userData(), name)
      if (existsSync(from)) cpSync(from, join(dest, name))
    }
    for (const name of FOLDERS) {
      const from = join(userData(), name)
      if (existsSync(from)) cpSync(from, join(dest, name), { recursive: true })
    }
    const info: BackupInfo = {
      path: dest,
      createdAt: new Date().toISOString(),
      reason,
      bytes: folderSize(dest),
      computer: hostname(),
      appVersion: app.getVersion()
    }
    writeFileSync(join(dest, 'backup.json'), JSON.stringify(info, null, 2), 'utf-8')
    if (!into) {
      updateSettings({ backupLastAt: info.createdAt, backupLastError: null })
      prune(parent)
    }
    return info
  } catch (err) {
    rmSync(dest, { recursive: true, force: true })
    if (!into) updateSettings({ backupLastError: `${new Date().toLocaleString()}: ${(err as Error).message}` })
    throw err
  } finally {
    backingUp = false
  }
}

/** Keeps the newest backups (the "before restore" ones are kept too, until they're the oldest). */
function prune(parent: string): void {
  const keep = Math.max(1, getSettings().backupKeep || 7)
  const all = listBackups(parent)
  for (const old of all.slice(keep)) rmSync(old.path, { recursive: true, force: true })
}

/** The backups in a folder, newest first. */
export function listBackups(parent = backupDir()): BackupInfo[] {
  if (!existsSync(parent)) return []
  const out: BackupInfo[] = []
  for (const name of readdirSync(parent)) {
    const path = join(parent, name)
    try {
      const info = JSON.parse(readFileSync(join(path, 'backup.json'), 'utf-8')) as BackupInfo
      out.push({ ...info, path })
    } catch {
      // not a backup
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

const pendingDir = (): string => join(userData(), 'restore-pending')

/**
 * Restoring replaces the data VibeApp has open (its database above all), so
 * it's staged here and applied at the next start, before anything opens it.
 * The current data is backed up first, so a restore can itself be undone.
 */
export function stageRestore(path: string): BackupInfo {
  const manifest = join(path, 'backup.json')
  if (!existsSync(manifest) || !existsSync(join(path, 'memory.db'))) throw new Error("That folder isn't a VibeApp backup.")
  const info = JSON.parse(readFileSync(manifest, 'utf-8')) as BackupInfo
  backupNow('before restore')
  rmSync(pendingDir(), { recursive: true, force: true })
  cpSync(path, pendingDir(), { recursive: true })
  return info
}

/** At startup: puts a staged restore in place. Runs before the database or anything else is opened. */
export function applyPendingRestore(): void {
  const pending = pendingDir()
  if (!existsSync(join(pending, 'backup.json'))) return
  // The database first: if it can't be replaced (still open somewhere), nothing else is touched
  // and the restore stays waiting for the next start, so the data is never half old, half new.
  const names = readdirSync(pending).filter((n) => n !== 'backup.json')
  names.sort((a, b) => (a === 'memory.db' ? -1 : b === 'memory.db' ? 1 : 0))
  const failed: string[] = []
  for (const name of names) {
    const target = join(userData(), name)
    try {
      if (name === 'memory.db') {
        rmSync(target, { force: true })
        rmSync(`${target}-wal`, { force: true })
        rmSync(`${target}-shm`, { force: true })
      } else {
        rmSync(target, { recursive: true, force: true })
      }
      renameSync(join(pending, name), target)
    } catch (err) {
      console.warn(`Restoring ${name} failed:`, (err as Error).message)
      if (name === 'memory.db') return
      failed.push(name)
    }
  }
  if (!failed.length) rmSync(pending, { recursive: true, force: true })
  console.log(failed.length ? `Restored VibeApp data, except ${failed.join(', ')} (tried again next start).` : 'Restored VibeApp data from a backup.')
}

/** Nightly backups: checked hourly (and soon after starting); one is made once a day has passed. */
export function scheduleBackups(): void {
  const check = (): void => {
    const s = getSettings()
    if (!s.backupDaily) return
    const last = s.backupLastAt ? Date.parse(s.backupLastAt) : 0
    if (Date.now() - last < 23 * 60 * 60 * 1000) return
    try {
      backupNow('nightly')
    } catch (err) {
      console.warn('Nightly backup failed:', (err as Error).message)
    }
  }
  setTimeout(check, 2 * 60_000).unref()
  setInterval(check, 60 * 60_000).unref()
}
