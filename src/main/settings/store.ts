import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '@shared/types'

const DEFAULTS: AppSettings = {
  claudeModel: null,
  codexModel: null,
  themeId: 'midnight',
  smartRouting: true,
  codexReview: true
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): AppSettings {
  const file = settingsPath()
  if (!existsSync(file)) return { ...DEFAULTS }
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppSettings>) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}
