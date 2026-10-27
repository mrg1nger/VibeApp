import { app, clipboard, Menu, nativeImage, Notification, Tray, type MenuItemConstructorOptions } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { AppSettings, ConfirmationRequest, ProjectRecord, VibeEvent } from '@shared/types'
import iconPath from '../../build/icon.png?asset'
import { addEventSink, invoke } from './remote/bus'
import { remoteStatus } from './remote/server'
import { getSettings } from './settings/store'
import { sendPhoneAlert } from './notify/phone'
import { isScheduledRun, upcoming } from './schedule/scheduler'

// The system tray icon: VibeApp can run with no window open (Remote access
// browsers and phones do the work), and the tray shows what's going on and
// lets the user open the window, copy the pairing code, stop work or quit.
// Notifications say when something is waiting on the user while no window is
// on screen.

interface TrayOptions {
  showWindow: () => void
  /** A VibeApp window is on screen right now (so no notification is needed). */
  windowShowing: () => boolean
  quit: () => void
}

/** Per project: since when a request has been running. */
const working = new Map<string, number>()
/** Per project: Allow/Deny prompts and questions waiting for an answer. */
const waiting = new Map<string, Set<string>>()
let projectNames = new Map<string, string>()
let tray: Tray | undefined
let options: TrayOptions | undefined
let rebuildTimer: ReturnType<typeof setTimeout> | undefined

const STARTED = new Set<VibeEvent['type']>(['route', 'tool_call', 'assistant_text', 'takeover_started', 'delegation_progress', 'plan_progress'])
/** A finished request is announced only if it took this long (a quick one is watched as it happens). */
const ANNOUNCE_AFTER_MS = 20_000

async function refreshNames(): Promise<void> {
  try {
    const projects = (await invoke('vibe:project:list', [])) as ProjectRecord[]
    projectNames = new Map(projects.map((p) => [p.id, p.name]))
  } catch {
    // names are only for display
  }
}

const nameOf = (projectId: string): string => projectNames.get(projectId) ?? 'A project'

function notify(title: string, body: string): void {
  notifyUser(title, body)
}

/**
 * Tells the user something needs them, when no VibeApp window is on screen:
 * a Windows notification, and an alert on their phone if they set that up.
 */
export function notifyUser(title: string, body: string): void {
  if (!options || options.windowShowing()) return
  if (Notification.isSupported()) {
    const n = new Notification({ title, body: body.slice(0, 240), silent: false })
    n.on('click', () => options?.showWindow())
    n.show()
  }
  void sendPhoneAlert(title, body.replace(/ Answer from a connected browser or phone, or open VibeApp\.$/, ''))
}

/** Keeps track of what's running and waiting, from the events sent to the screens. */
function watch(channel: string, args: unknown[]): void {
  if (channel === 'vibe:chat:event') {
    const [projectId, event] = args as [string, VibeEvent]
    if (STARTED.has(event.type) && !working.has(projectId)) working.set(projectId, Date.now())
    if (event.type === 'plan_proposed') notify(`${nameOf(projectId)}: plan ready`, 'Claude has a plan for you to approve, change or cancel.')
    if (event.type === 'takeover_offer') notify(`${nameOf(projectId)}: Claude is out`, 'Codex can take this request. Open VibeApp to say whether it should.')
    if (event.type === 'turn_complete' || event.type === 'stopped') {
      const since = working.get(projectId)
      working.delete(projectId)
      waiting.delete(projectId)
      // A scheduled request says how it went itself.
      if (event.type === 'turn_complete' && since && Date.now() - since > ANNOUNCE_AFTER_MS && !isScheduledRun(projectId)) {
        notify(`${nameOf(projectId)}: finished`, 'The request you sent is done.')
      }
    }
    scheduleRebuild()
  } else if (channel === 'vibe:chat:confirmationRequest') {
    const [projectId, request] = args as [string, ConfirmationRequest]
    const set = waiting.get(projectId) ?? new Set<string>()
    set.add(request.id)
    waiting.set(projectId, set)
    notify(
      `${nameOf(projectId)}: ${request.questions?.length ? 'Claude has a question' : 'Claude is asking permission'}`,
      `${request.reason}. Answer from a connected browser or phone, or open VibeApp.`
    )
    scheduleRebuild()
  } else if (channel === 'vibe:schedules:changed') {
    scheduleRebuild()
  } else if (channel === 'vibe:settings:changed') {
    applyLoginItem(args[0] as AppSettings)
    scheduleRebuild()
  }
}

/** Starting with Windows, in the tray. Only for the installed app (a dev build would register Electron itself). */
export function applyLoginItem(settings: AppSettings = getSettings()): void {
  if (!app.isPackaged || process.platform === 'darwin') return
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.startWithWindows, args: ['--tray'] })
  } catch (err) {
    console.warn('Changing "start with Windows" failed:', (err as Error).message)
  }
}

function scheduleRebuild(): void {
  if (rebuildTimer) return
  rebuildTimer = setTimeout(() => {
    rebuildTimer = undefined
    void rebuild()
  }, 300)
}

/** Prompts still open, asked from the sessions themselves (the events alone don't say when one was answered). */
async function pendingPrompts(): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const projectId of new Set([...waiting.keys(), ...working.keys()])) {
    try {
      const pending = (await invoke('vibe:chat:pendingConfirmations', [projectId])) as ConfirmationRequest[]
      if (pending.length) out.set(projectId, pending.length)
      else waiting.delete(projectId)
    } catch {
      // a project with no session has nothing pending
    }
  }
  return out
}

function when(iso: string): string {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return d.toLocaleString([], today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/** The next few schedules across every project, and the switch that pauses them all. */
function scheduleItems(settings: AppSettings): MenuItemConstructorOptions[] {
  const next = upcoming(3)
  if (!next.length && !settings.schedulesPaused) return [{ label: 'No schedules', enabled: false }]
  return [
    ...(settings.schedulesPaused
      ? []
      : next.map(({ schedule, at }) => ({ label: `⏰ ${when(at)}: ${schedule.name} (${nameOf(schedule.projectId)})`, enabled: false }))),
    {
      label: 'Pause all schedules',
      type: 'checkbox' as const,
      checked: !!settings.schedulesPaused,
      click: (item: { checked: boolean }) => void invoke('vibe:settings:update', [{ schedulesPaused: item.checked }])
    }
  ]
}

async function rebuild(): Promise<void> {
  if (!tray || !options) return
  const opts = options
  await refreshNames()
  const settings = getSettings()
  const remote = remoteStatus()
  const online = remote.devices.filter((d) => d.online).length
  const prompts = await pendingPrompts()

  const activity: MenuItemConstructorOptions[] = []
  for (const projectId of new Set([...working.keys(), ...prompts.keys()])) {
    const ask = prompts.get(projectId)
    activity.push({
      label: `${nameOf(projectId)}: ${ask ? `waiting for you (${ask === 1 ? 'Allow/Deny or a question' : `${ask} prompts`})` : 'working…'}`,
      click: () => opts.showWindow()
    })
  }

  const items: MenuItemConstructorOptions[] = [
    { label: 'Open VibeApp', click: () => opts.showWindow() },
    { type: 'separator' },
    remote.running
      ? { label: `Remote access: on · ${online} connected${remote.readOnly ? ' · read-only' : ''}`, enabled: false }
      : { label: 'Remote access: off (turn it on in Settings)', click: () => opts.showWindow() }
  ]
  if (remote.running) {
    items.push(
      { label: `Copy address (${remote.urls[0]})`, click: () => clipboard.writeText(remote.urls[0] ?? '') },
      { label: `Copy pairing code (${remote.pairingCode})`, click: () => clipboard.writeText(remote.pairingCode) }
    )
  }
  items.push(
    { type: 'separator' },
    ...(activity.length ? activity : [{ label: 'Nothing running', enabled: false } as MenuItemConstructorOptions]),
    {
      label: 'Stop all work',
      enabled: working.size > 0 || prompts.size > 0,
      click: () => {
        for (const projectId of new Set([...working.keys(), ...prompts.keys()])) {
          void Promise.resolve(invoke('vibe:chat:stop', [projectId])).catch(() => undefined)
        }
      }
    },
    { type: 'separator' },
    ...scheduleItems(settings),
    { type: 'separator' },
    {
      label: 'Keep running in the tray when the window is closed',
      type: 'checkbox',
      checked: !!settings.trayMode,
      click: (item) => void invoke('vibe:settings:update', [{ trayMode: item.checked }])
    },
    {
      label: 'Start with Windows, in the tray',
      type: 'checkbox',
      checked: !!settings.startWithWindows,
      enabled: app.isPackaged,
      click: (item) => void invoke('vibe:settings:update', [{ startWithWindows: item.checked }])
    },
    { type: 'separator' },
    { label: 'Quit VibeApp', click: () => opts.quit() }
  )

  tray.setContextMenu(Menu.buildFromTemplate(items))
  const busy = activity.length ? ` · ${activity.length} ${prompts.size ? 'need you' : 'working'}` : ''
  tray.setToolTip(`VibeApp${busy} · Remote access ${remote.running ? `on (${online} connected)` : 'off'}`)

  // The tests read the menu, since a tray can't be clicked from a script.
  if (process.env.VIBEAPP_TEST_HOOKS === '1') {
    try {
      writeFileSync(
        join(app.getPath('userData'), 'test-tray.json'),
        JSON.stringify({ items: items.map((i) => i.label ?? '').filter(Boolean), at: Date.now() })
      )
    } catch {
      // test aid only
    }
  }
}

export function setupTray(opts: TrayOptions): void {
  options = opts
  const image = nativeImage.createFromPath(iconPath)
  tray = new Tray(image.isEmpty() ? image : image.resize({ width: 16, height: 16 }))
  tray.setToolTip('VibeApp')
  tray.on('click', () => opts.showWindow())
  addEventSink(watch)
  // Connected devices come and go without events; keep the counts fresh.
  setInterval(() => void rebuild(), 10_000).unref()
  void rebuild()
}

/** Called when the window closes but VibeApp keeps running: says so, once per run. */
let toldAboutTray = false
export function noteStillRunning(): void {
  if (toldAboutTray || !Notification.isSupported()) return
  toldAboutTray = true
  const remote = remoteStatus()
  const n = new Notification({
    title: 'VibeApp is still running',
    body: remote.running
      ? 'It keeps working in the tray, and your browsers and phone stay connected. Right-click the tray icon to open it or quit.'
      : "It keeps working in the tray. Remote access is off, so open it from the tray icon when you need it."
  })
  n.on('click', () => options?.showWindow())
  n.show()
}
