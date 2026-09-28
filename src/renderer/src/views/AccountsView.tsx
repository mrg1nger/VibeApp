import { useCallback, useEffect, useState } from 'react'
import type { CliName, CliStatus } from '@shared/types'
import LoginTerminal from '../components/LoginTerminal'

const CLI_LABELS: Record<CliName, string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}

const STATUS_LABELS: Record<CliStatus['status'], string> = {
  checking: 'Checking…',
  logged_in: 'Logged in',
  logged_out: 'Not logged in',
  not_installed: 'Not installed'
}

function AccountsView() {
  const [statuses, setStatuses] = useState<Record<CliName, CliStatus>>({
    claude: { cli: 'claude', status: 'checking' },
    codex: { cli: 'codex', status: 'checking' }
  })
  const [activeLogin, setActiveLogin] = useState<{ cli: CliName; sessionId: string } | null>(null)

  const refresh = useCallback(async (cli: CliName) => {
    const status = await window.vibe.auth.check(cli)
    setStatuses((prev) => ({ ...prev, [cli]: status }))
  }, [])

  useEffect(() => {
    refresh('claude')
    refresh('codex')
  }, [refresh])

  const handleLogin = useCallback(async (cli: CliName) => {
    const sessionId = await window.vibe.auth.login(cli)
    setActiveLogin({ cli, sessionId })
  }, [])

  const handleLoginExit = useCallback(
    (cli: CliName) => {
      setActiveLogin(null)
      refresh(cli)
    },
    [refresh]
  )

  return (
    <div className="accounts-view">
      <h2>Accounts</h2>
      <div className="accounts-list">
        {(['claude', 'codex'] as const).map((cli) => {
          const status = statuses[cli]
          return (
            <div key={cli} className="account-row">
              <span className="account-name">{CLI_LABELS[cli]}</span>
              <span className={`status-pill status-${status.status}`}>
                {STATUS_LABELS[status.status]}
              </span>
              {status.status !== 'not_installed' && (
                <button onClick={() => handleLogin(cli)} disabled={activeLogin?.cli === cli}>
                  Log in
                </button>
              )}
            </div>
          )
        })}
      </div>

      {activeLogin && (
        <div className="login-panel">
          <div className="login-panel-header">
            <span>Logging in to {CLI_LABELS[activeLogin.cli]}…</span>
            <button onClick={() => handleLoginExit(activeLogin.cli)}>Close</button>
          </div>
          <LoginTerminal
            sessionId={activeLogin.sessionId}
            onExit={() => handleLoginExit(activeLogin.cli)}
          />
        </div>
      )}
    </div>
  )
}

export default AccountsView
