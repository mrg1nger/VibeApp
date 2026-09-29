import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, CliName, CliStatus, ProjectRecord, ThemeDefinition } from '@shared/types'
import AccountsView from './views/AccountsView'
import ProjectPickerView from './views/ProjectPickerView'
import ChatView from './views/ChatView'
import HistoryView from './views/HistoryView'
import MemoryView from './views/MemoryView'
import SettingsView from './views/SettingsView'
import ToastHost from './components/ToastHost'
import UsageMeters from './components/UsageMeters'
import { useToasts } from './lib/useToasts'
import { applyTheme } from './lib/theme'

type Screen = 'accounts' | 'projects' | 'chat' | 'history' | 'memory' | 'settings'

const STATUS_POLL_INTERVAL_MS = 15_000

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
      setStatuses((prev) => ({ ...prev, [cli]: status }))
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
  }, [reloadThemes])

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
        <div className="app-nav-tabs">
          <button
            className={screen === 'accounts' ? 'active' : ''}
            onClick={() => setScreen('accounts')}
          >
            Accounts
          </button>
          <button
            className={screen === 'projects' || screen === 'chat' || screen === 'history' ? 'active' : ''}
            onClick={() => setScreen('projects')}
            disabled={!claudeReady}
            title={claudeReady ? undefined : 'Log in to Claude Code first'}
          >
            Projects
          </button>
          <button className={screen === 'memory' ? 'active' : ''} onClick={() => setScreen('memory')}>
            Memory
          </button>
          <button
            className={screen === 'settings' ? 'active' : ''}
            onClick={() => setScreen('settings')}
          >
            Settings
          </button>
        </div>
        <UsageMeters statuses={statuses} />
      </div>

      {screen === 'accounts' && <AccountsView statuses={statuses} onRefresh={refreshStatus} />}

      {screen === 'projects' && claudeReady && (
        <ProjectPickerView
          onOpen={(project) => {
            setActiveProject(project)
            setScreen('chat')
          }}
          onError={showError}
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
      {screen === 'memory' && <MemoryView project={activeProject} />}
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
