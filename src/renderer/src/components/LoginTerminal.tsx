import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface LoginTerminalProps {
  sessionId: string
  onExit: (exitCode: number) => void
}

function LoginTerminal({ sessionId, onExit }: LoginTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      theme: { background: '#0d0f14' }
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      window.vibe.login.resize(sessionId, term.cols, term.rows)
    })
    resizeObserver.observe(container)

    const inputDisposable = term.onData((data) => {
      window.vibe.login.write(sessionId, data)
    })

    const unsubData = window.vibe.login.onData((id, data) => {
      if (id === sessionId) term.write(data)
    })
    const unsubExit = window.vibe.login.onExit((id, exitCode) => {
      if (id === sessionId) onExit(exitCode)
    })

    window.vibe.login.resize(sessionId, term.cols, term.rows)

    return () => {
      resizeObserver.disconnect()
      inputDisposable.dispose()
      unsubData()
      unsubExit()
      term.dispose()
      window.vibe.login.dispose(sessionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return <div ref={containerRef} className="login-terminal" />
}

export default LoginTerminal
