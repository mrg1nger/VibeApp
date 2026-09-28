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

interface AccountsViewProps {
  statuses: Record<CliName, CliStatus>
  onRefresh: (cli: CliName) => void
}

type RunningTask =
  | { kind: 'login'; cli: CliName; sessionId: string }
  | { kind: 'install'; cli: CliName; sessionId: string }
  | { kind: 'install-node'; sessionId: string }

function AccountsView({ statuses, onRefresh }: AccountsViewProps) {
  const [task, setTask] = useState<RunningTask | null>(null)
  const [nodeReady, setNodeReady] = useState<boolean | null>(null)

  const refreshNode = useCallback(() => {
    window.vibe.auth.checkNode().then(setNodeReady)
  }, [])

  useEffect(() => {
    refreshNode()
  }, [refreshNode])

  const handleLogin = useCallback(async (cli: CliName) => {
    const sessionId = await window.vibe.auth.login(cli)
    setTask({ kind: 'login', cli, sessionId })
  }, [])

  const handleInstall = useCallback(async (cli: CliName) => {
    const sessionId = await window.vibe.auth.install(cli)
    setTask({ kind: 'install', cli, sessionId })
  }, [])

  const handleInstallNode = useCallback(async () => {
    const sessionId = await window.vibe.auth.installNode()
    setTask({ kind: 'install-node', sessionId })
  }, [])

  const handleTaskExit = useCallback(() => {
    if (!task) return
    setTask(null)
    if (task.kind === 'install-node') {
      refreshNode()
    } else {
      onRefresh(task.cli)
    }
  }, [task, onRefresh, refreshNode])

  return (
    <div className="accounts-view">
      <h2>Accounts</h2>

      <div className="accounts-list">
        <div className="account-row">
          <span className="account-name">Node.js (required to install Claude Code / Codex)</span>
          <span
            className={`status-pill ${
              nodeReady === null ? 'status-checking' : nodeReady ? 'status-logged_in' : 'status-not_installed'
            }`}
          >
            {nodeReady === null ? 'Checking…' : nodeReady ? 'Installed' : 'Not installed'}
          </span>
          {nodeReady === false && (
            <button onClick={handleInstallNode} disabled={task !== null}>
              Install
            </button>
          )}
        </div>

        {(['claude', 'codex'] as const).map((cli) => {
          const status = statuses[cli]
          return (
            <div key={cli} className="account-row">
              <span className="account-name">{CLI_LABELS[cli]}</span>
              <span className={`status-pill status-${status.status}`}>
                {STATUS_LABELS[status.status]}
              </span>
              {status.status === 'not_installed' && (
                <button
                  onClick={() => handleInstall(cli)}
                  disabled={task !== null || nodeReady !== true}
                  title={nodeReady !== true ? 'Install Node.js first' : undefined}
                >
                  Install
                </button>
              )}
              {status.status !== 'not_installed' && (
                <button onClick={() => handleLogin(cli)} disabled={task !== null}>
                  Log in
                </button>
              )}
            </div>
          )
        })}
      </div>

      {task && (
        <div className="login-panel">
          <div className="login-panel-header">
            <span>
              {task.kind === 'login' && `Logging in to ${CLI_LABELS[task.cli]}…`}
              {task.kind === 'install' && `Installing ${CLI_LABELS[task.cli]}…`}
              {task.kind === 'install-node' && 'Installing Node.js…'}
            </span>
            <button onClick={handleTaskExit}>Close</button>
          </div>
          {task.kind === 'install-node' && (
            <p className="install-hint">
              Windows may show a separate permission (UAC) prompt for this install — check your
              taskbar/screen if it seems stuck.
            </p>
          )}
          <LoginTerminal
            sessionId={task.sessionId}
            onExit={handleTaskExit}
            api={task.kind === 'login' ? window.vibe.login : window.vibe.install}
          />
        </div>
      )}
    </div>
  )
}

export default AccountsView
