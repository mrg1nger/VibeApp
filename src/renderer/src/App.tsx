import { useCallback, useEffect, useState } from 'react'
import type { CliName, CliStatus, ProjectRecord } from '@shared/types'
import AccountsView from './views/AccountsView'
import ProjectPickerView from './views/ProjectPickerView'
import ChatView from './views/ChatView'
import HistoryView from './views/HistoryView'
import ToastHost from './components/ToastHost'
import { useToasts } from './lib/useToasts'

type Screen = 'accounts' | 'projects' | 'chat' | 'history'

const STATUS_POLL_INTERVAL_MS = 15_000

function App() {
  const [screen, setScreen] = useState<Screen>('accounts')
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null)
  const [statuses, setStatuses] = useState<Record<CliName, CliStatus>>({
    claude: { cli: 'claude', status: 'checking' },
    codex: { cli: 'codex', status: 'checking' }
  })
  const { toasts, pushToast, dismissToast } = useToasts()

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
        </div>
      </div>

      {screen === 'accounts' && <AccountsView statuses={statuses} onRefresh={refreshStatus} />}

      {screen === 'projects' && claudeReady && (
        <ProjectPickerView
          onOpen={(project) => {
            setActiveProject(project)
            setScreen('chat')
          }}
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
          onError={(message) => pushToast(message, 'error')}
        />
      )}
      {screen === 'history' && activeProject && (
        <HistoryView project={activeProject} onBack={() => setScreen('chat')} />
      )}

      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

export default App
