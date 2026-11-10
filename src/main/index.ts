import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
import { broadcaster } from './remote/bus'
import { registerRemoteHandlers } from './remote/ipc'
import { applyRemoteSettings, stopRemote } from './remote/server'
import { stopAllPreviews } from './preview/preview'
import { stopAllChildren } from './cli/codexExec'
import { requestClassifier } from './orchestrator/classifier'
import { getSettings } from './settings/store'
import { applyLoginItem, noteStillRunning, setupTray } from './tray'
import { applyPendingRestore, scheduleBackups } from './backup/backup'
import { startUpdateChecks, stopUpdateChecks } from './updates/updates'

let currentWindow: BrowserWindow | undefined
/** Started with --tray (e.g. with Windows): no window until the user asks for one. */
const startInTray = process.argv.includes('--tray')
let quitting = false

/** Keep running with no window: the setting, or started in the tray. */
const keepRunningInTray = (): boolean => startInTray || !!getSettings().trayMode

function showWindow(): void {
  if (!currentWindow || currentWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (currentWindow.isMinimized()) currentWindow.restore()
  currentWindow.show()
  currentWindow.focus()
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // For the live preview pane; locked down in will-attach-webview below.
      webviewTag: true
    }
  })

  // The preview only ever shows the user's own app on localhost, with no
  // preload and no Node access, whatever the renderer asks for.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    if (!/^http:\/\/localhost(:\d+)?\//.test(params.src)) event.preventDefault()
  })
  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler((details) => {
      if (/^https?:\/\//.test(details.url)) shell.openExternal(details.url)
      return { action: 'deny' }
    })
    // Links out of the app open in the real browser instead of the preview.
    guest.on('will-navigate', (event, url) => {
      if (/^http:\/\/localhost(:\d+)?\//.test(url)) return
      event.preventDefault()
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
    })
  })

  currentWindow = mainWindow

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    if (currentWindow === mainWindow) currentWindow = undefined
    // The window is gone (its memory freed) but the work goes on in the tray.
    if (!quitting && keepRunningInTray()) noteStillRunning()
  })

  // Only web and mail links leave the app: file:, ms-*: and other handlers could start programs.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^(https?:\/\/|mailto:)/i.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })
  // The window keeps VibeApp's own screens: any other page would get the preload's full API.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow.webContents.getURL()) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// The end-to-end test runs the app against its own data folder, so it never
// touches the user's projects, memory or settings.
if (process.env.VIBEAPP_USER_DATA) app.setPath('userData', process.env.VIBEAPP_USER_DATA)

// One VibeApp at a time (per data folder): a second copy would start its own
// Remote access server on the same port. Starting it again opens the window.
const firstCopy = app.requestSingleInstanceLock()
if (!firstCopy) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (app.isReady()) showWindow()
  })
}

app.whenReady().then(() => {
  // A second copy only passes the "open the window" request on, then quits.
  if (!firstCopy) return
  // The same id the installer gives the Start menu shortcut, or Windows doesn't show its notifications.
  electronApp.setAppUserModelId('com.vibeapp.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // A restore chosen last time goes in place before anything opens the data.
  applyPendingRestore()

  // Events go to the desktop window and to any Remote access screens.
  const toScreens = broadcaster(() => currentWindow?.webContents)
  registerIpcHandlers(toScreens)
  registerRemoteHandlers()
  // New versions on GitHub Releases (a banner when there's one).
  startUpdateChecks((channel, ...args) => toScreens()?.send(channel, ...args))
  // Remote access, if the user switched it on.
  applyRemoteSettings().catch((err) => console.warn('Remote access failed to start:', (err as Error).message))

  setupTray({
    showWindow,
    windowShowing: () => !!currentWindow && !currentWindow.isDestroyed() && currentWindow.isVisible() && !currentWindow.isMinimized(),
    quit: () => {
      quitting = true
      app.quit()
    }
  })
  applyLoginItem()
  scheduleBackups()
  if (!startInTray) createWindow()

  // Get Haiku's request labeller running before the first message needs it.
  setTimeout(() => {
    const settings = getSettings()
    if (settings.smartRouting && settings.aiRouting) requestClassifier.warmUp()
  }, 3_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  stopAllPreviews()
  stopUpdateChecks()
  // Codex jobs, test runs and tool checks still going: nothing keeps working after VibeApp is closed.
  stopAllChildren()
  void stopRemote()
  requestClassifier.dispose()
})

app.on('window-all-closed', () => {
  // In the tray, closing the window doesn't stop VibeApp: Quit in the tray menu does.
  if (keepRunningInTray() && !quitting) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
