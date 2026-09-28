import { app } from 'electron'
import { join } from 'path'

export function globalMemoryPath(): string {
  return join(app.getPath('userData'), 'memory-global.json')
}

export function projectMemoryPath(projectId: string): string {
  return join(app.getPath('userData'), 'memory-projects', `${projectId}.json`)
}

export function memoryServerScriptPath(): string {
  // Sits next to the compiled main bundle at runtime (out/main/index.js and
  // out/main/memory/memoryServer.mjs), copied there by electron.vite.config.ts's
  // copyMemoryServerPlugin. __dirname resolves correctly in both dev and a
  // packaged app since it's the actual location of the running main script.
  return join(__dirname, 'memory', 'memoryServer.mjs')
}
