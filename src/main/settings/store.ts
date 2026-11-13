import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '@shared/types'

const DEFAULTS: AppSettings = {
  agentBalance: 'auto',
  limitTakeover: 'auto',
  autoAsk: true,
  rotateAtTokens: 120_000,
  autoCompact: true,
  remoteAccess: 'off',
  remotePort: 7428,
  remoteReadOnly: false,
  planBigRequests: 'ask',
  claudeModel: null,
  codexModel: null,
  codexEffort: null,
  trayMode: false,
  schedulesPaused: false,
  startWithWindows: false,
  backupDaily: true,
  backupDir: null,
  backupKeep: 7,
  backupLastAt: null,
  backupLastError: null,
  phoneAlerts: false,
  phoneAlertServer: 'https://ntfy.sh',
  phoneAlertTopic: null,
  themeId: 'midnight',
  smartRouting: true,
  aiRouting: true,
  codeMap: true,
  autoMemory: true,
  freshSessions: false,
  exportAgentsFile: false,
  stepUpForComplex: false,
  codexReview: true,
  clineHandoffs: true,
  clineHelpers: true,
  clineModel: null,
  clineHelperModel: null,
  lmStudioHelpers: false,
  lmStudioUrl: 'http://localhost:1234',
  lmStudioModel: null,
  updateChecks: true,
  skippedVersion: null,
  lastRunVersion: null
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
