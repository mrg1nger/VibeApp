import { app } from 'electron'
import { join } from 'path'

export function globalMemoryPath(): string {
  return join(app.getPath('userData'), 'memory-global.json')
}

export function projectMemoryPath(projectId: string): string {
  return join(app.getPath('userData'), 'memory-projects', `${projectId}.json`)
}

export function memoryServerScriptPath(): string {
  // Self-contained bundle emitted next to out/main/index.js by
  // electron.vite.config.ts's bundleMemoryServerPlugin.
  return join(__dirname, 'memory', 'memoryServer.cjs')
}
