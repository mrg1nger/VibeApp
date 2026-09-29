import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface PtyApi {
  onData: (cb: (sessionId: string, data: string) => void) => () => void
  onExit: (cb: (sessionId: string, exitCode: number) => void) => () => void
  write: (sessionId: string, data: string) => void
  resize: (sessionId: string, cols: number, rows: number) => void
  dispose: (sessionId: string) => void
}

interface LoginTerminalProps {
  sessionId: string
  onExit: (exitCode: number) => void
  api?: PtyApi
}

function LoginTerminal({ sessionId, onExit, api = window.vibe.login }: LoginTerminalProps) {
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
    // Sign-in flows print links; window.open hands them to the real browser.
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)))
    term.open(container)
    fitAddon.fit()

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      api.resize(sessionId, term.cols, term.rows)
    })
    resizeObserver.observe(container)

    const inputDisposable = term.onData((data) => {
      api.write(sessionId, data)
    })

    const unsubData = api.onData((id, data) => {
      if (id === sessionId) term.write(data)
    })
    const unsubExit = api.onExit((id, exitCode) => {
      if (id === sessionId) onExit(exitCode)
    })

    api.resize(sessionId, term.cols, term.rows)

    return () => {
      resizeObserver.disconnect()
      inputDisposable.dispose()
      unsubData()
      unsubExit()
      term.dispose()
      api.dispose(sessionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return <div ref={containerRef} className="login-terminal" />
}

export default LoginTerminal
