import { app } from 'electron'
import { join } from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { getLoadablePath } from 'sqlite-vec'
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

/**
 * The sqlite-vec add-on, which compares vectors inside the database. In the installed app
 * it sits outside app.asar: Windows can't load a DLL from inside the archive.
 */
function vectorExtensionPath(): string | undefined {
  try {
    return getLoadablePath().replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
  } catch (err) {
    console.warn('The sqlite-vec add-on was not found; comparing vectors without it:', (err as Error).message)
    return undefined
  }
}

/** The language model the memory search runs on this computer (fetched by scripts/fetch-model.mjs). */
export function searchModelFolder(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'models', 'gte-small')
    : join(__dirname, '..', '..', 'resources', 'models', 'gte-small')
}

let imported = false

/** The main process's connection, with the old JSON memory moved in on first use. */
export function memoryDb(): DatabaseSync {
  const db = openMemory(memoryDbPath(), vectorExtensionPath())
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
