import { useCallback, useEffect, useRef, useState } from 'react'
import type { PickedElement, PreviewProblem, PreviewState } from '@shared/types'

/** What this pane needs from the page it shows: Electron's <webview>, or a frame in a browser. */
interface PreviewSurface {
  reload(): void
  executeJavaScript<T = unknown>(code: string): Promise<T>
  getURL(): string
  addEventListener(type: string, listener: (event: Event) => void): void
  removeEventListener(type: string, listener: (event: Event) => void): void
}

/**
 * In a browser (Remote access) the preview is relayed from another port into an
 * <iframe>, so it can't be reached into directly. A helper the relay adds to
 * the page answers over postMessage: this wraps that to look like a <webview>.
 */
class FramePreview extends EventTarget implements PreviewSurface {
  private nextId = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(private readonly frame: HTMLIFrameElement) {
    super()
    window.addEventListener('message', this.onMessage)
  }

  dispose(): void {
    window.removeEventListener('message', this.onMessage)
    for (const p of this.pending.values()) p.reject(new Error('The preview closed.'))
    this.pending.clear()
  }

  private onMessage = (event: MessageEvent): void => {
    const data = event.data as { __vibe?: boolean; type?: string; id?: number; result?: unknown; error?: string; level?: string; message?: string }
    if (event.source !== this.frame.contentWindow || !data?.__vibe) return
    if (data.type === 'console') {
      this.dispatchEvent(Object.assign(new Event('console-message'), { level: data.level, message: data.message }))
    } else if (data.type === 'result' && data.id !== undefined) {
      const p = this.pending.get(data.id)
      this.pending.delete(data.id)
      if (data.error) p?.reject(new Error(data.error))
      else p?.resolve(data.result)
    }
  }

  private post(message: object): void {
    try {
      this.frame.contentWindow?.postMessage({ __vibe: true, ...message }, new URL(this.frame.src).origin)
    } catch {
      // the frame is navigating
    }
  }

  reload(): void {
    this.post({ type: 'reload' })
  }

  executeJavaScript<T = unknown>(code: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.post({ type: 'run', id, code })
    })
  }

  getURL(): string {
    return this.frame.src
  }
}

const inBrowser = window.vibe.host === 'browser'

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
  const webviewRef = useRef<PreviewSurface | null>(null)
  // In a browser: the relayed address of the preview, and the frame showing it.
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const frameRef = useRef<FramePreview | null>(null)
  const setFrame = useCallback((el: HTMLIFrameElement | null) => {
    frameRef.current?.dispose()
    frameRef.current = el ? new FramePreview(el) : null
    webviewRef.current = frameRef.current
  }, [])
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
  const runningUrl = state.status === 'running' ? state.url : ''
  useEffect(() => {
    if (!inBrowser || !runningUrl) {
      setFrameUrl(null)
      return
    }
    let cancelled = false
    window.vibe.remote
      .previewUrl(projectId)
      .then((r) => {
        if (!cancelled) setFrameUrl(r ? `${r.secure ? 'https' : 'http'}://${location.hostname}:${r.port}/` : null)
      })
      .catch(() => !cancelled && setFrameUrl(null))
    return () => {
      cancelled = true
    }
  }, [projectId, runningUrl])
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
  }, [running, frameUrl])

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
      ? inBrowser
        ? (frameUrl ?? 'Connecting…')
        : state.url
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
          <button onClick={() => window.open(inBrowser ? (frameUrl ?? state.url) : state.url)} title="Open in a new tab">
            ↗
          </button>
        )}
        <button className={showLog ? 'active' : ''} onClick={() => setShowLog(!showLog)} title="Server output">
          Log
        </button>
      </div>

      <div className="preview-body">
        {running &&
          (inBrowser ? (
            frameUrl ? (
              <iframe ref={setFrame} src={frameUrl} title="Preview of your app" className="preview-frame" />
            ) : (
              <div className="preview-message">Connecting to the preview…</div>
            )
          ) : (
            <webview
              ref={(el) => void (webviewRef.current = el as unknown as PreviewSurface | null)}
              src={state.url}
              partition={`preview-${projectId}`}
            />
          ))}
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
