import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { UpdateState } from '@shared/types'
import { isNewer, justUpdatedFrom } from '@shared/update'
import { getSettings, updateSettings } from '../settings/store'

// New versions come from the GitHub repository's Releases (the installer plus the
// latest.yml electron-builder writes next to it). electron-updater checks there,
// downloads the installer, checks it against latest.yml's SHA-512, and installs it
// quietly over this copy before starting VibeApp again. Nothing is downloaded
// until the user presses Update.

export const RELEASES_URL = 'https://github.com/mrg1nger/VibeApp/releases'
const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 6 * 60 * 60_000

type Send = (channel: string, ...args: unknown[]) => void
type Updater = typeof import('electron-updater').autoUpdater

let state: UpdateState = { status: 'idle', current: app.getVersion(), releasesUrl: RELEASES_URL, canInstall: false }
let send: Send = () => undefined
let updater: Updater | undefined
let timer: ReturnType<typeof setInterval> | undefined

/** The test switch: a file naming a version to pretend is on GitHub (the app tests can't publish releases). */
function testVersion(): string | undefined {
  if (process.env.VIBEAPP_TEST_HOOKS !== '1') return undefined
  try {
    return readFileSync(join(app.getPath('userData'), 'test-update-version'), 'utf-8').trim() || undefined
  } catch {
    return undefined
  }
}

/** The packaged-app test: a stand-in for GitHub on this computer. It downloads and checks, but never installs. */
const testFeed = (): string | undefined =>
  process.env.VIBEAPP_TEST_HOOKS === '1' ? process.env.VIBEAPP_TEST_UPDATE_FEED || undefined : undefined

export const releaseUrlFor =(version: string): string => `${RELEASES_URL}/tag/v${version}`

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  send('vibe:update:changed', state)
}

export function updateState(): UpdateState {
  return state
}

function plain(err: unknown): string {
  const text = String((err as Error)?.message ?? err)
  if (/404|Not Found|Cannot find latest|No published versions/i.test(text)) return "No releases can be seen on GitHub yet."
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(text)) return "GitHub couldn't be reached. Check the internet connection."
  if (/sha512 checksum mismatch/i.test(text)) return "The download didn't match the release's checksum, so it wasn't installed. Try again."
  return text.split('\n')[0].slice(0, 200)
}

function getUpdater(): Updater | undefined {
  if (updater || !app.isPackaged) return updater
  // Loaded only in the installed app: from source there's nothing to update.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = null
  const feed = testFeed()
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed })
  autoUpdater.on('update-available', (info) =>
    set({ status: 'available', version: info.version, releaseUrl: releaseUrlFor(info.version), error: undefined })
  )
  autoUpdater.on('update-not-available', () => set({ status: 'none', error: undefined }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', () => set({ status: 'ready', percent: 100 }))
  autoUpdater.on('error', (err) => set({ status: state.version ? 'error' : 'none', error: plain(err) }))
  updater = autoUpdater
  return updater
}

/** Looks on GitHub for a newer version. */
export async function checkForUpdate(): Promise<UpdateState> {
  if (state.status === 'downloading' || state.status === 'ready') return state
  const fake = testVersion()
  if (fake) {
    set({ status: 'checking' })
    const newer = isNewer(fake, state.current)
    set({ status: newer ? 'available' : 'none', version: fake, releaseUrl: releaseUrlFor(fake), canInstall: true, checkedAt: new Date().toISOString() })
    return state
  }
  const u = getUpdater()
  if (!u) return state
  set({ status: 'checking', error: undefined })
  try {
    await u.checkForUpdates()
  } catch (err) {
    set({ status: state.version ? 'error' : 'none', error: plain(err) })
  }
  set({ checkedAt: new Date().toISOString(), ...(state.status === 'checking' ? { status: 'none' as const } : {}) })
  return state
}

/**
 * Downloads the new version, then closes VibeApp, installs it quietly and starts it
 * again. Refused while a project has a request running, unless `anyway`.
 */
export async function installUpdate(busy: string[], anyway = false): Promise<UpdateState> {
  if (!anyway && busy.length) {
    throw new Error(`${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} still working. Updating restarts VibeApp and stops that.`)
  }
  if (testVersion()) {
    // The test app can't really install: it shows the steps, then says it's done and doesn't restart.
    set({ status: 'downloading', percent: 0, error: undefined })
    setTimeout(() => set({ status: 'downloading', percent: 60 }), 300)
    setTimeout(() => set({ status: 'ready', percent: 100 }), 900)
    setTimeout(() => set({ status: 'none', version: undefined, percent: undefined }), 2500)
    return state
  }
  const u = getUpdater()
  if (!u || !state.version) throw new Error('There is no update to install.')
  if (state.status !== 'ready') {
    set({ status: 'downloading', percent: 0, error: undefined })
    try {
      await u.downloadUpdate()
    } catch (err) {
      set({ status: 'error', error: plain(err) })
      return state
    }
  }
  if (testFeed()) return state
  // Quiet install over this copy, then start the new version.
  setImmediate(() => u.quitAndInstall(true, true))
  return state
}

/** Checks soon after start and every few hours, while "Look for updates" is on. */
export function startUpdateChecks(sendToScreens: Send): void {
  send = sendToScreens
  const { lastRunVersion } = getSettings()
  state = { ...state, canInstall: app.isPackaged, updatedFrom: justUpdatedFrom(lastRunVersion, state.current) }
  if (lastRunVersion !== state.current) updateSettings({ lastRunVersion: state.current })
  const due = (): void => {
    if (getSettings().updateChecks) void checkForUpdate()
  }
  setTimeout(due, FIRST_CHECK_MS)
  timer = setInterval(due, CHECK_EVERY_MS)
}

export function stopUpdateChecks(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
