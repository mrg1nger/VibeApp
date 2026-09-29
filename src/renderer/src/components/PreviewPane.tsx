import { useCallback, useEffect, useRef, useState } from 'react'
import type { PickedElement, PreviewProblem, PreviewState } from '@shared/types'

/** The bits of Electron's <webview> element this pane uses. */
interface WebviewElement extends HTMLElement {
  reload(): void
  executeJavaScript<T = unknown>(code: string): Promise<T>
  getURL(): string
}

interface PreviewPaneProps {
  projectId: string
  projectPath: string
  /** Bumped when Claude finishes a turn, so the preview can catch up. */
  refreshToken: number
  picking: boolean
  onPickingChange: (picking: boolean) => void
  onPicked: (element: PickedElement) => void
  onProblem: (problem: PreviewProblem) => void
}

// Injected into the previewed page: highlights whatever the pointer is over
// and resolves with a description of the clicked element (null on Escape).
const PICKER_SCRIPT = `(() => new Promise((resolve) => {
  if (window.__vibeCancelPick) window.__vibeCancelPick();
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #ff5eaa;background:rgba(255,94,170,.15);border-radius:3px;display:none';
  const style = document.createElement('style');
  style.textContent = '* { cursor: crosshair !important; }';
  document.documentElement.append(box, style);
  let current = null;
  const selectorFor = (el) => {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement && parts.length < 6) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      let s = el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      const p = el.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === el.tagName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
      }
      parts.unshift(s);
      el = p;
    }
    return parts.join(' > ');
  };
  const move = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box) return;
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  };
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
  const click = (e) => {
    swallow(e);
    const el = current || e.target;
    let html = el.outerHTML;
    if (html.length > 1500) html = html.slice(0, 1500) + '…';
    finish({
      pageUrl: location.pathname + location.search,
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.getAttribute('alt') || el.getAttribute('aria-label') || '').trim().slice(0, 300),
      html
    });
  };
  const key = (e) => { if (e.key === 'Escape') { swallow(e); finish(null); } };
  const events = [['mousemove', move], ['click', click], ['keydown', key], ['mousedown', swallow], ['mouseup', swallow], ['pointerdown', swallow], ['pointerup', swallow]];
  function finish(result) {
    for (const [type, fn] of events) document.removeEventListener(type, fn, true);
    box.remove();
    style.remove();
    delete window.__vibeCancelPick;
    resolve(result);
  }
  window.__vibeCancelPick = () => finish(null);
  for (const [type, fn] of events) document.addEventListener(type, fn, true);
}))()`

const IGNORED_PAGE_ERRORS = /favicon\.ico|Download the React DevTools|\[HMR\]|\[vite\] (connecting|connected)/i

function PreviewPane({
  projectId,
  projectPath,
  refreshToken,
  picking,
  onPickingChange,
  onPicked,
  onProblem
}: PreviewPaneProps) {
  const [state, setState] = useState<PreviewState>({ status: 'idle' })
  const [log, setLog] = useState('')
  const [showLog, setShowLog] = useState(false)
  const webviewRef = useRef<WebviewElement | null>(null)
  const autoStarted = useRef(false)
  const stateRef = useRef(state)
  stateRef.current = state
  const onProblemRef = useRef(onProblem)
  onProblemRef.current = onProblem

  const start = useCallback(() => {
    window.vibe.preview.start(projectId, projectPath).catch((err: Error) => {
      onProblemRef.current({ source: 'server', message: `Couldn't start the preview: ${err.message}` })
    })
  }, [projectId, projectPath])

  useEffect(() => {
    autoStarted.current = false
    let cancelled = false
    window.vibe.preview.state(projectId).then((current) => {
      if (cancelled) return
      setState(current)
      if (current.status === 'idle' && !autoStarted.current) {
        autoStarted.current = true
        start()
      }
    })
    const unsubscribe = window.vibe.preview.onState((id, next) => {
      if (id === projectId) setState(next)
    })
    const unsubscribeProblem = window.vibe.preview.onProblem((id, problem) => {
      if (id === projectId) onProblemRef.current(problem)
    })
    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeProblem()
    }
  }, [projectId, start])

  // Keep the server log fresh while it matters.
  const logVisible = showLog || state.status === 'starting' || state.status === 'crashed'
  useEffect(() => {
    if (!logVisible) return
    const load = (): void => {
      window.vibe.preview.log(projectId).then(setLog)
    }
    load()
    const interval = setInterval(load, 1000)
    return () => clearInterval(interval)
  }, [projectId, logVisible])

  // After Claude finishes: bring the preview up to date with its changes.
  const firstRefresh = useRef(true)
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false
      return
    }
    const current = stateRef.current
    if (current.status === 'crashed' || current.status === 'none' || current.status === 'idle') {
      start() // maybe Claude fixed it, or there's something to show now
    } else if (current.status === 'running' && current.command === 'npm start') {
      start() // plain servers don't reload their own code
    } else if (current.status === 'running') {
      webviewRef.current?.reload()
    }
  }, [refreshToken, start])

  // Page errors, straight from the preview's console.
  const running = state.status === 'running'
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || !running) return
    const onConsole = (event: Event): void => {
      const { level, message } = event as Event & { level: number | string; message: string }
      if ((level === 3 || level === 'error') && !IGNORED_PAGE_ERRORS.test(message)) {
        onProblemRef.current({ source: 'page', message })
      }
    }
    webview.addEventListener('console-message', onConsole)
    return () => webview.removeEventListener('console-message', onConsole)
  }, [running])

  // Point-and-ask.
  useEffect(() => {
    const webview = webviewRef.current
    if (!picking) return
    if (!webview || !running) {
      onPickingChange(false)
      return
    }
    let active = true
    webview
      .executeJavaScript<PickedElement | null>(PICKER_SCRIPT)
      .then((picked) => {
        if (!active) return
        onPickingChange(false)
        if (picked) onPicked(picked)
      })
      .catch(() => active && onPickingChange(false))
    return () => {
      active = false
      webview.executeJavaScript('window.__vibeCancelPick && window.__vibeCancelPick()').catch(() => undefined)
    }
  }, [picking, running, onPicked, onPickingChange])

  const statusText =
    state.status === 'running'
      ? state.url
      : state.status === 'starting'
        ? `Starting (${state.command})…`
        : state.status === 'crashed'
          ? 'App stopped'
          : state.status === 'none'
            ? 'No preview'
            : 'Stopped'

  return (
    <div className="preview-pane">
      <div className="preview-toolbar">
        <span className={`preview-dot preview-dot-${state.status}`} />
        <span className="preview-status" title={statusText}>
          {statusText}
        </span>
        <button
          className={picking ? 'active' : ''}
          onClick={() => onPickingChange(!picking)}
          disabled={!running}
          title="Click something in your app, then tell Claude what to change about it"
        >
          🎯 {picking ? 'Cancel' : 'Point'}
        </button>
        <button onClick={() => webviewRef.current?.reload()} disabled={!running} title="Reload the page">
          ⟳
        </button>
        <button onClick={start} title="Restart the app">
          {state.status === 'idle' ? 'Start' : 'Restart'}
        </button>
        {state.status !== 'idle' && state.status !== 'none' && (
          <button onClick={() => window.vibe.preview.stop(projectId)}>Stop</button>
        )}
        {running && (
          <button onClick={() => window.open(state.url)} title="Open in your web browser">
            ↗
          </button>
        )}
        <button className={showLog ? 'active' : ''} onClick={() => setShowLog(!showLog)} title="Server output">
          Log
        </button>
      </div>

      <div className="preview-body">
        {running && <webview ref={(el) => void (webviewRef.current = el as WebviewElement | null)} src={state.url} partition={`preview-${projectId}`} />}
        {state.status === 'starting' && <div className="preview-message">Starting your app…</div>}
        {state.status === 'none' && <div className="preview-message">{state.message}</div>}
        {state.status === 'crashed' && (
          <div className="preview-message">
            <p>Your app stopped running.</p>
            <button onClick={start}>Try again</button>
          </div>
        )}
        {state.status === 'idle' && (
          <div className="preview-message">
            <button onClick={start}>Start preview</button>
          </div>
        )}
        {picking && <div className="preview-pick-hint">Click the part of your app you want to change · Esc to cancel</div>}
      </div>

      {logVisible && <pre className="preview-log">{log || 'No output yet.'}</pre>}
    </div>
  )
}

export default PreviewPane
