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

type ToolName = 'node' | 'git'

const TOOL_LABELS: Record<ToolName, string> = {
  node: 'Node.js (required to install Claude Code / Codex)',
  git: 'Git (required for project checkpoints/history)'
}

interface AccountsViewProps {
  statuses: Record<CliName, CliStatus>
  onRefresh: (cli: CliName) => void
}

type RunningTask =
  | { kind: 'login'; cli: CliName; sessionId: string }
  | { kind: 'install'; cli: CliName; sessionId: string }
  | { kind: 'install-tool'; tool: ToolName; sessionId: string }

function AccountsView({ statuses, onRefresh }: AccountsViewProps) {
  const [task, setTask] = useState<RunningTask | null>(null)
  const [toolReady, setToolReady] = useState<Record<ToolName, boolean | null>>({
    node: null,
    git: null
  })

  const refreshTool = useCallback((tool: ToolName) => {
    const check = tool === 'node' ? window.vibe.auth.checkNode() : window.vibe.auth.checkGit()
    check.then((ready) => setToolReady((prev) => ({ ...prev, [tool]: ready })))
  }, [])

  useEffect(() => {
    refreshTool('node')
    refreshTool('git')
  }, [refreshTool])

  const handleLogin = useCallback(async (cli: CliName) => {
    const sessionId = await window.vibe.auth.login(cli)
    setTask({ kind: 'login', cli, sessionId })
  }, [])

  const handleInstall = useCallback(async (cli: CliName) => {
    const sessionId = await window.vibe.auth.install(cli)
    setTask({ kind: 'install', cli, sessionId })
  }, [])

  const handleInstallTool = useCallback(async (tool: ToolName) => {
    const sessionId = tool === 'node' ? await window.vibe.auth.installNode() : await window.vibe.auth.installGit()
    setTask({ kind: 'install-tool', tool, sessionId })
  }, [])

  const handleTaskExit = useCallback(() => {
    if (!task) return
    setTask(null)
    if (task.kind === 'install-tool') {
      refreshTool(task.tool)
    } else {
      onRefresh(task.cli)
    }
  }, [task, onRefresh, refreshTool])

  return (
    <div className="accounts-view">
      <h2>Accounts</h2>

      <div className="accounts-list">
        {(['node', 'git'] as const).map((tool) => {
          const ready = toolReady[tool]
          return (
            <div key={tool} className="account-row">
              <span className="account-name">{TOOL_LABELS[tool]}</span>
              <span
                className={`status-pill ${
                  ready === null ? 'status-checking' : ready ? 'status-logged_in' : 'status-not_installed'
                }`}
              >
                {ready === null ? 'Checking…' : ready ? 'Installed' : 'Not installed'}
              </span>
              {ready === false && (
                <button onClick={() => handleInstallTool(tool)} disabled={task !== null}>
                  Install
                </button>
              )}
            </div>
          )
        })}

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
                  disabled={task !== null || toolReady.node !== true}
                  title={toolReady.node !== true ? 'Install Node.js first' : undefined}
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
              {task.kind === 'install-tool' && `Installing ${task.tool === 'node' ? 'Node.js' : 'Git'}…`}
            </span>
            <button onClick={handleTaskExit}>Close</button>
          </div>
          {task.kind === 'install-tool' && (
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
