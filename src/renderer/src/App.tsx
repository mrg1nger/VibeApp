import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, CliName, CliStatus, ProjectRecord, ThemeDefinition } from '@shared/types'
import AccountsView from './views/AccountsView'
import ProjectPickerView from './views/ProjectPickerView'
import ChatView from './views/ChatView'
import HistoryView from './views/HistoryView'
import MemoryView from './views/MemoryView'
import SettingsView from './views/SettingsView'
import ExtensionsView from './views/ExtensionsView'
import TalkView from './views/TalkView'
import ToastHost from './components/ToastHost'
import UsageMeters from './components/UsageMeters'
import { useToasts } from './lib/useToasts'
import { applyTheme } from './lib/theme'

type Screen = 'accounts' | 'projects' | 'chat' | 'history' | 'memory' | 'extensions' | 'talk' | 'settings'

// Logins and installs re-check right away (AccountsView), so this only catches
// changes made outside the app.
const STATUS_POLL_INTERVAL_MS = 60_000

function App() {
  const [screen, setScreen] = useState<Screen>('accounts')
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null)
  const [statuses, setStatuses] = useState<Record<CliName, CliStatus>>({
    claude: { cli: 'claude', status: 'checking' },
    codex: { cli: 'codex', status: 'checking' }
  })
  const { toasts, pushToast, dismissToast } = useToasts()
  const showError = useCallback((message: string) => pushToast(message, 'error'), [pushToast])

  const refreshStatus = useCallback((cli: CliName) => {
    window.vibe.auth.check(cli).then((status) => {
      // A check that timed out on a busy machine says nothing new; keep what
      // we knew instead of flipping to "logged out" mid-session.
      setStatuses((prev) =>
        status.inconclusive && prev[cli].status !== 'checking' ? prev : { ...prev, [cli]: status }
      )
    })
  }, [])

  useEffect(() => {
    refreshStatus('claude')
    refreshStatus('codex')
    const interval = setInterval(() => {
      refreshStatus('claude')
      refreshStatus('codex')
    }, STATUS_POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [refreshStatus])

  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [themes, setThemes] = useState<ThemeDefinition[]>([])

  const reloadThemes = useCallback(async () => {
    setThemes(await window.vibe.themes.list())
  }, [])

  useEffect(() => {
    window.vibe.settings.get().then(setSettings)
    reloadThemes()
    // Changed in another window (or on another device): show it here too.
    return window.vibe.settings.onChanged(setSettings)
  }, [reloadThemes])

  // Remote access indicator (desktop): on, and how many browsers or tools are connected.
  const [remoteOnline, setRemoteOnline] = useState<number | null>(null)
  useEffect(() => {
    if (window.vibe.host === 'browser') return
    const check = (): void => {
      window.vibe.remote
        .status()
        .then((s) => setRemoteOnline(s.running ? s.devices.filter((d) => d.online).length : null))
        .catch(() => undefined)
    }
    check()
    const timer = setInterval(check, 5000)
    return () => clearInterval(timer)
  }, [settings?.remoteAccess])

  const activeTheme = themes.find((t) => t.id === settings?.themeId) ?? themes[0]
  useEffect(() => {
    if (activeTheme) applyTheme(activeTheme)
  }, [activeTheme])

  const changeSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        setSettings(await window.vibe.settings.update(patch))
      } catch (err) {
        showError(`Couldn't save settings: ${(err as Error).message}`)
        throw err
      }
    },
    [showError]
  )

  const claudeReady = statuses.claude.status === 'logged_in'
  const claudeChecking = statuses.claude.status === 'checking'

  return (
    <div className="app">
      <div className="app-nav">
        <h1>VibeApp</h1>
        <div className="app-nav-tabs" data-scroll-x>
          <button
            className={screen === 'accounts' ? 'active' : ''}
            onClick={() => setScreen('accounts')}
          >
            Accounts
          </button>
          <button
            className={screen === 'projects' || screen === 'chat' || screen === 'history' || screen === 'memory' ? 'active' : ''}
            onClick={() => setScreen('projects')}
            disabled={!claudeReady}
            title={claudeReady ? undefined : 'Log in to Claude Code first'}
          >
            Projects
          </button>
          <button className={screen === 'talk' ? 'active' : ''} onClick={() => setScreen('talk')}>
            Chat
          </button>
          <button className={screen === 'extensions' ? 'active' : ''} onClick={() => setScreen('extensions')}>
            Extensions
          </button>
          <button
            className={screen === 'settings' ? 'active' : ''}
            onClick={() => setScreen('settings')}
          >
            Settings
          </button>
        </div>
        {window.vibe.host === 'browser' ? (
          <span className="remote-indicator" title="You're using VibeApp through Remote access">📡 Remote</span>
        ) : (
          remoteOnline !== null && (
            <button
              className="remote-indicator"
              onClick={() => setScreen('settings')}
              title="Remote access is on (Settings, Remote access)"
            >
              📡 Remote{remoteOnline ? ` · ${remoteOnline} connected` : ''}
            </button>
          )
        )}
        <UsageMeters
          statuses={statuses}
          balance={settings?.agentBalance ?? 'auto'}
          onBalanceChange={(agentBalance) => changeSettings({ agentBalance }).catch(() => undefined)}
        />
      </div>

      {screen === 'accounts' && <AccountsView statuses={statuses} onRefresh={refreshStatus} />}

      {screen === 'projects' && claudeReady && (
        <ProjectPickerView
          onOpen={(project) => {
            setActiveProject(project)
            setScreen('chat')
          }}
          onError={showError}
          onRemoved={(projectId) => setActiveProject((current) => (current?.id === projectId ? null : current))}
        />
      )}
      {screen === 'projects' && !claudeReady && !claudeChecking && (
        <div className="empty-state">
          <h2>Claude Code isn't ready yet</h2>
          <p>
            {statuses.claude.status === 'not_installed'
              ? "Claude Code doesn't seem to be installed on this machine."
              : "You're not logged in to Claude Code yet."}
          </p>
          <button onClick={() => setScreen('accounts')}>Go to Accounts</button>
        </div>
      )}

      {screen === 'chat' && activeProject && (
        <ChatView
          project={activeProject}
          onBack={() => setScreen('projects')}
          onOpenHistory={() => setScreen('history')}
          onOpenMemory={() => setScreen('memory')}
          onError={showError}
          thinkingLabel={activeTheme?.thinkingLabel ?? 'Claude is working…'}
        />
      )}
      {screen === 'history' && activeProject && (
        <HistoryView
          project={activeProject}
          onBack={() => setScreen('chat')}
          onError={showError}
        />
      )}
      {screen === 'memory' && activeProject && (
        <MemoryView project={activeProject} onBack={() => setScreen('chat')} onError={showError} />
      )}
      {screen === 'talk' && <TalkView onError={showError} />}
      {screen === 'extensions' && <ExtensionsView onError={showError} />}
      {screen === 'settings' && settings && (
        <SettingsView
          settings={settings}
          themes={themes}
          onSettingsChange={changeSettings}
          onThemesChange={reloadThemes}
          onError={showError}
        />
      )}

      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

export default App
