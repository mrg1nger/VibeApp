// Added by VibeApp's Remote access to the previewed page when it's shown in a
// browser. The page sits in a frame from another port, so VibeApp's screen
// can't reach into it directly: this lets it reload the page, run its
// point-and-ask picker, and hear about errors. It only takes instructions from
// the VibeApp screen that framed it.
;(() => {
  if (window.__vibeHelper || window.parent === window) return
  window.__vibeHelper = true
  const post = (message) => window.parent.postMessage({ __vibe: true, ...message }, '*')
  const fromVibeApp = (event) => {
    if (event.source !== window.parent || !event.data || !event.data.__vibe) return false
    try {
      return new URL(event.origin).hostname === location.hostname
    } catch {
      return false
    }
  }

  window.addEventListener('message', async (event) => {
    if (!fromVibeApp(event)) return
    const { type, id, code } = event.data
    if (type === 'reload') location.reload()
    if (type === 'run') {
      try {
        // Indirect eval: runs in the page's global scope, like Electron's executeJavaScript.
        const result = await (0, eval)(code)
        post({ type: 'result', id, result })
      } catch (err) {
        post({ type: 'result', id, error: String(err && err.message ? err.message : err) })
      }
    }
  })

  const report = (message) => post({ type: 'console', level: 'error', message: String(message).slice(0, 4000) })
  window.addEventListener('error', (e) => report(`${e.message}${e.filename ? ` (${e.filename}:${e.lineno})` : ''}`))
  window.addEventListener('unhandledrejection', (e) => report(`Unhandled promise rejection: ${e.reason && e.reason.message ? e.reason.message : e.reason}`))
  const original = console.error
  console.error = (...args) => {
    report(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    original.apply(console, args)
  }
  post({ type: 'loaded', url: location.href })
})()
