import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ProjectRecord } from '@shared/types'

interface ProjectsFile {
  projects: ProjectRecord[]
}

function storePath(): string {
  return join(app.getPath('userData'), 'projects.json')
}

function readStore(): ProjectsFile {
  const file = storePath()
  if (!existsSync(file)) return { projects: [] }
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as ProjectsFile
  } catch {
    return { projects: [] }
  }
}

function writeStore(data: ProjectsFile): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf-8')
}

export function listProjects(): ProjectRecord[] {
  return readStore().projects.sort((a, b) => b.lastOpened.localeCompare(a.lastOpened))
}

export function recordProjectOpened(path: string): ProjectRecord {
  const data = readStore()
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  const existing = data.projects.find((p) => p.path === path)

  const record: ProjectRecord = existing
    ? { ...existing, lastOpened: new Date().toISOString() }
    : { id: randomUUID(), path, name, lastOpened: new Date().toISOString() }

  data.projects = [record, ...data.projects.filter((p) => p.path !== path)]
  writeStore(data)
  return record
}

export function setSdkSessionId(projectId: string, sdkSessionId: string): void {
  const data = readStore()
  const project = data.projects.find((p) => p.id === projectId)
  if (!project) return
  project.sdkSessionId = sdkSessionId
  writeStore(data)
}

export function getProject(projectId: string): ProjectRecord | undefined {
  return readStore().projects.find((p) => p.id === projectId)
}
