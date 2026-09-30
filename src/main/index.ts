import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
import { stopAllPreviews } from './preview/preview'
import { requestClassifier } from './orchestrator/classifier'
import { getSettings } from './settings/store'

let currentWindow: BrowserWindow | undefined

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
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.vibeapp')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers(() => currentWindow?.webContents)

  createWindow()

  // Get Haiku's request labeller running before the first message needs it.
  setTimeout(() => {
    const settings = getSettings()
    if (settings.smartRouting && settings.aiRouting) requestClassifier.warmUp()
  }, 3_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  stopAllPreviews()
  requestClassifier.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
