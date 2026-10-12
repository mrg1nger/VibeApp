import { app } from 'electron'
import { join } from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { openMemory, importLegacyMemory, closeStaleHandoffs } from './store'

/** The shared memory database (all projects plus global). */
export function memoryDbPath(): string {
  return join(app.getPath('userData'), 'memory.db')
}

/** The old JSON memory files, imported once into the database and kept as a backup. */
function legacyGlobalPath(): string {
  return join(app.getPath('userData'), 'memory-global.json')
}

function legacyProjectsDir(): string {
  return join(app.getPath('userData'), 'memory-projects')
}

let imported = false

/** The main process's connection, with the old JSON memory moved in on first use. */
export function memoryDb(): DatabaseSync {
  const db = openMemory(memoryDbPath())
  if (!imported) {
    imported = true
    try {
      importLegacyMemory(db, legacyGlobalPath(), legacyProjectsDir())
      closeStaleHandoffs(db)
    } catch (err) {
      console.warn('Importing old memory files failed:', (err as Error).message)
    }
  }
  return db
}

export function memoryServerScriptPath(): string {
  // Self-contained bundle emitted next to out/main/index.js by
  // electron.vite.config.ts's bundleMemoryServerPlugin.
  return join(__dirname, 'memory', 'memoryServer.cjs')
}
