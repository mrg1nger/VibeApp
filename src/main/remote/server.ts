import { app, nativeImage } from 'electron'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { createServer as createHttpsServer, type ServerOptions as HttpsOptions } from 'https'
import { connect as netConnect, type Socket } from 'net'
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { hostname, networkInterfaces } from 'os'
import { extname, join, normalize, resolve, sep } from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RemoteStatus } from '@shared/types'
import { getSettings } from '../settings/store'
import { findPreview } from '../preview/preview'
import { addEventSink, hasChannel, invoke } from './bus'
import {
  checkRemoteCall,
  deviceForToken,
  ensureApiToken,
  listDevices,
  pair,
  pairingCode,
  PairingError,
  type Device
} from './auth'
import { sniCallback, startTrustedCert, stopTrustedCert, trustedCert, trustedCertProblem } from './tailscale'
import iconPath from '../../../build/icon.png?asset'

// Remote access: VibeApp's screens in a web browser, and an API (HTTP, a
// WebSocket, and an MCP server for Claude Code), all through the same actions
// the desktop window uses. Off by default. "This computer" listens on
// 127.0.0.1 only; "local network" listens on all addresses over HTTPS with a
// self-signed certificate. Every request needs a token from pairing.

const COOKIE = 'vibeapp_session'

interface Running {
  server: Server
  mode: 'local' | 'lan'
  port: number
  secure: boolean
  stopEvents: () => void
}

let running: Running | undefined
let lastError: string | undefined
const sockets = new Set<{ ws: WebSocket; device: Device }>()
const sseClients = new Set<{ res: ServerResponse; device: Device }>()
const previewProxies = new Map<string, { server: Server; port: number; target: string }>()

const rendererDir = (): string => join(__dirname, '../renderer')
const remoteAsset = (name: string): string => join(__dirname, 'remote', name)

// ---- small helpers ------------------------------------------------------------------

function tokenFrom(req: IncomingMessage, url?: URL): string | undefined {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  const cookie = req.headers.cookie ?? ''
  const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookie)
  if (match) return decodeURIComponent(match[1])
  return url?.searchParams.get('token') ?? undefined
}

/** Browsers cap a cookie at 400 days; a remembered device's is renewed each time VibeApp is opened, so it never runs out. */
const REMEMBER_SECONDS = 400 * 24 * 60 * 60

/** A remembered device's cookie lasts (and is renewed); otherwise it's a session cookie that ends when the browser closes. */
function sessionCookie(token: string, remember: boolean, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${remember ? `; Max-Age=${REMEMBER_SECONDS}` : ''}${secure ? '; Secure' : ''}`
}

function usesCookie(req: IncomingMessage): boolean {
  return !req.headers.authorization && new RegExp(`(?:^|;\\s*)${COOKIE}=`).test(req.headers.cookie ?? '')
}

/**
 * "This computer" mode answers only to local names. A website that points its own name at
 * 127.0.0.1 (DNS rebinding) would otherwise count as VibeApp's own origin and could try pairing codes.
 */
function hostOk(req: IncomingMessage, secure: boolean): boolean {
  if (secure) return true
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

function ownOrigin(req: IncomingMessage, secure: boolean): string {
  return `${secure ? 'https' : 'http'}://${req.headers.host ?? ''}`
}

/** A cookie-authenticated request must come from VibeApp's own page (stops other sites using the cookie). */
function originOk(req: IncomingMessage, secure: boolean): boolean {
  if (!usesCookie(req)) return true
  const origin = req.headers.origin
  return !!origin && origin === ownOrigin(req, secure)
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers
  })
  res.end(text)
}

function readBody(req: IncomingMessage, limit = 25 * 1024 * 1024): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Request too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function address(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
}

function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
  }
  return out
}

// ---- certificate (local-network mode) --------------------------------------------------

async function certificate(): Promise<{ key: string; cert: string }> {
  const file = join(app.getPath('userData'), 'remote-cert.json')
  const ips = ['127.0.0.1', ...lanAddresses()]
  try {
    const saved = JSON.parse(readFileSync(file, 'utf-8')) as { key: string; cert: string; ips: string[]; expires: number }
    if (saved.expires > Date.now() + 7 * 86_400_000 && ips.every((ip) => saved.ips.includes(ip))) return saved
  } catch {
    // none yet, or unreadable
  }
  const selfsigned = (await import('selfsigned')).default ?? (await import('selfsigned'))
  const notAfter = new Date()
  notAfter.setFullYear(notAfter.getFullYear() + 2)
  const pems = await (selfsigned as { generate: (a: unknown, o: unknown) => Promise<{ private: string; cert: string }> }).generate(
    [{ name: 'commonName', value: `VibeApp on ${hostname()}` }],
    {
      // Elliptic-curve: as strong as RSA here, and made in a moment instead of most of a minute.
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notAfterDate: notAfter,
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [{ type: 2, value: 'localhost' }, { type: 2, value: hostname() }, ...ips.map((ip) => ({ type: 7, ip }))]
        }
      ]
    }
  )
  const saved = { key: pems.private, cert: pems.cert, ips, expires: notAfter.getTime() }
  writeFileSync(file, JSON.stringify(saved), 'utf-8')
  return saved
}

/** VibeApp's own certificate, or Tailscale's trusted one when the browser came by the Tailscale name. */
async function httpsOptions(): Promise<HttpsOptions> {
  return { ...(await certificate()), SNICallback: sniCallback }
}

// ---- installing as an app (phones and desktop Chrome/Edge) ------------------------------
// Public on purpose: browsers fetch these without the session cookie, and none of it says anything private.

const THEME = '#0f1117'

const MANIFEST = JSON.stringify({
  id: '/',
  name: 'VibeApp',
  short_name: 'VibeApp',
  description: 'Your VibeApp, from this device.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: THEME,
  theme_color: THEME,
  icons: [
    { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/pwa/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
})

// Only page loads go through it, and only to show a friendly page when the computer can't be reached.
const SERVICE_WORKER = `const OFFLINE = ${JSON.stringify(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="${THEME}"><title>VibeApp</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:${THEME};color:#e6e8ee;font:15px/1.5 system-ui,sans-serif;text-align:center}main{padding:24px;max-width:340px}h1{font-size:20px;margin:0 0 8px}p{color:#9aa3b2;margin:0 0 20px}button{padding:11px 22px;border:0;border-radius:8px;background:#4f7cff;color:#fff;font:inherit;font-weight:600}</style>
</head><body><main><h1>Can't reach VibeApp</h1><p>Check that the computer running VibeApp is on, and that this device is connected to Tailscale (or the same network).</p><button onclick="location.reload()">Try again</button></main></body></html>`)}
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return
  event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
})
`

const icons = new Map<string, Buffer>()
function appIcon(name: string): Buffer | null {
  if (!icons.has(name)) {
    const image = nativeImage.createFromPath(iconPath)
    if (image.isEmpty()) return null
    const { width } = image.getSize()
    // Maskable: the phone cuts its own shape, so the picture has to fill the square (no transparent corners).
    const inset = Math.round(width * 0.117)
    const source = name === 'icon-maskable-512.png' ? image.crop({ x: inset, y: inset, width: width - 2 * inset, height: width - 2 * inset }) : image
    const size = name === 'icon-192.png' ? 192 : 512
    icons.set(name, source.resize({ width: size, height: size, quality: 'best' }).toPNG())
  }
  return icons.get(name) ?? null
}

const HEAD_TAGS = `<link rel="manifest" href="/manifest.webmanifest" /><meta name="theme-color" content="${THEME}" /><link rel="icon" href="/pwa/icon-192.png" /><link rel="apple-touch-icon" href="/pwa/icon-192.png" />`

/** The install files, or false when the path is something else. */
function servePwa(path: string, res: ServerResponse): boolean {
  const publicHeaders = { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }
  if (path === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', ...publicHeaders })
    res.end(MANIFEST)
    return true
  }
  if (path === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', ...publicHeaders })
    res.end(SERVICE_WORKER)
    return true
  }
  const icon = /^\/pwa\/(icon-192\.png|icon-512\.png|icon-maskable-512\.png)$/.exec(path)
  if (icon) {
    const png = appIcon(icon[1])
    if (!png) return send(res, 404, { error: 'Not found' }), true
    res.writeHead(200, { 'Content-Type': 'image/png', ...publicHeaders })
    res.end(png)
    return true
  }
  return false
}

// ---- pages ---------------------------------------------------------------------------

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VibeApp: connect</title>
${HEAD_TAGS}
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1117;color:#e6e8ee;font:15px/1.5 system-ui,sans-serif}
main{width:min(360px,calc(100vw - 32px));background:#171a22;border:1px solid #2a2f3a;border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 6px}p{color:#9aa3b2;margin:0 0 18px}label{display:block;font-size:13px;color:#9aa3b2;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2a2f3a;background:#0f1117;color:inherit;font:inherit}
#code{letter-spacing:.4em;font-size:22px;text-align:center}button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:#4f7cff;color:#fff;font:inherit;font-weight:600;cursor:pointer}
#err{color:#ff8a8a;min-height:1.5em;margin:10px 0 0;font-size:14px}
.check{display:flex;gap:10px;align-items:flex-start;margin-top:16px;font-size:14px;color:#e6e8ee}.check input{width:auto;margin-top:3px}.check small{display:block;color:#9aa3b2;font-size:12.5px}
</style></head><body><main>
<h1>Connect to VibeApp</h1>
<p>Enter the pairing code shown in VibeApp on your computer (Settings, Remote access).</p>
<form id="f"><label for="code">Pairing code</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus>
<label for="name">Name this device</label><input id="name" maxlength="60" placeholder="e.g. Laptop browser">
<label class="check"><input type="checkbox" id="remember" checked><span>Remember this device<small>Stays connected until you disconnect it in VibeApp's Settings. Untick on a computer that isn't yours: it then lasts until this browser closes.</small></span></label>
<button type="submit">Connect</button><p id="err" role="alert"></p></form></main>
<script>
// Opening the installed app, or a link from another app, arrives "from outside", and the browser holds the
// session cookie back (it's SameSite=Strict). From this page it is sent: if this device is paired, go straight in.
document.documentElement.style.visibility = 'hidden'
const show = () => (document.documentElement.style.visibility = '')
setTimeout(show, 3000)
const tried = Number(sessionStorage.getItem('vibeapp-forward') || 0)
if (Date.now() - tried < 10000) show() // just tried and came back: show the form rather than loop
else fetch('/api/status', { credentials: 'same-origin' }).then((r) => {
  if (!r.ok) return show()
  sessionStorage.setItem('vibeapp-forward', String(Date.now()))
  location.replace('/')
}).catch(show)
document.getElementById('name').value = (navigator.userAgent.match(/(Firefox|Edg|Chrome|Safari)\\//)?.[1] ?? 'Browser').replace('Edg', 'Edge') + ' browser'
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = document.getElementById('err'); err.textContent = ''
  const r = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: document.getElementById('code').value, name: document.getElementById('name').value, remember: document.getElementById('remember').checked }) })
  const body = await r.json().catch(() => ({}))
  if (r.ok) location.href = '/'
  else err.textContent = body.error || 'That did not work.'
})
</script></body></html>`

/** The app's page, with the browser bridge and a policy that also allows the WebSocket and preview frames. */
function appPage(req: IncomingMessage, secure: boolean): string | null {
  const file = join(rendererDir(), 'index.html')
  if (!existsSync(file)) return null
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  const scheme = secure ? 'https' : 'http'
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ${secure ? 'wss' : 'ws'}://${req.headers.host}`,
    `frame-src ${scheme}://${host}:*`
  ].join('; ')
  return readFileSync(file, 'utf-8')
    .replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, `<meta http-equiv="Content-Security-Policy" content="${policy}" />`)
    .replace(/<script\b/i, '<script src="/remote/bridge.js"></script>\n    <script')
    .replace(/<\/title>/i, (m) => `${m}\n    ${HEAD_TAGS}`)
}

function serveFile(res: ServerResponse, file: string): void {
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Not found' })
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(readFileSync(file))
}

// ---- the API ---------------------------------------------------------------------------

/** Runs one action for a remote caller, with the read-only and desktop-only rules applied. */
async function runAction(channel: string, args: unknown[], device: Device): Promise<{ status: number; body: unknown }> {
  if (typeof channel !== 'string' || !hasChannel(channel)) return { status: 404, body: { error: `Unknown action: ${channel}` } }
  const readOnly = device.readOnly || getSettings().remoteReadOnly
  const check = checkRemoteCall(channel, Array.isArray(args) ? args : [], readOnly)
  if (!check.allowed) return { status: 403, body: { error: check.reason } }
  try {
    const result = await invoke(channel, check.args ?? args ?? [])
    return { status: 200, body: { result: result === undefined ? null : result } }
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') } }
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, secure: boolean): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  if (!hostOk(req, secure)) return send(res, 421, { error: 'Open VibeApp at localhost.' })
  if (servePwa(path, res)) return

  if (path === '/login') return send(res, 200, LOGIN_PAGE, { 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'" })

  if (path === '/api/pair' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req, 4096)) as { code?: string; name?: string; remember?: boolean }
      const remember = body.remember !== false
      const { token, device } = pair(String(body.code ?? ''), String(body.name ?? ''), address(req), getSettings().remoteReadOnly, remember)
      return send(res, 200, { token, readOnly: device.readOnly, device: device.name, remember }, {
        'Set-Cookie': sessionCookie(token, remember, secure)
      })
    } catch (err) {
      return send(res, err instanceof PairingError ? err.status : 400, { error: (err as Error).message })
    }
  }

  const device = deviceForToken(tokenFrom(req))
  if (!device) {
    if (path.startsWith('/api/') || path.startsWith('/remote/')) return send(res, 401, { error: 'Not paired. Pair with the code shown in VibeApp.' })
    res.writeHead(302, { Location: '/login' })
    return void res.end()
  }

  if (path === '/api/status') {
    return send(res, 200, { app: 'VibeApp', version: app.getVersion(), device: device.name, readOnly: device.readOnly || getSettings().remoteReadOnly })
  }

  if (path === '/api/invoke' && req.method === 'POST') {
    if (!originOk(req, secure)) return send(res, 403, { error: 'Requests from other sites are not allowed.' })
    let parsed: { channel?: string; args?: unknown[] }
    try {
      parsed = JSON.parse(await readBody(req))
    } catch {
      return send(res, 400, { error: 'Expected JSON: { "channel": "...", "args": [...] }' })
    }
    const { status, body } = await runAction(String(parsed.channel), parsed.args ?? [], device)
    return send(res, status, body)
  }

  if (path === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    res.write(': connected\n\n')
    const client = { res, device }
    sseClients.add(client)
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    req.on('close', () => {
      clearInterval(ping)
      sseClients.delete(client)
    })
    return
  }

  if (path === '/remote/bridge.js') return serveFile(res, remoteAsset('bridge.js'))

  // The app's own screens.
  if (path === '/' || path === '/index.html') {
    const page = appPage(req, secure)
    if (!page) return send(res, 503, 'VibeApp has to be built (npm run build) before its screens can be served.')
    const renew: Record<string, string> = device.remember && usesCookie(req) ? { 'Set-Cookie': sessionCookie(tokenFrom(req)!, true, secure) } : {}
    return send(res, 200, page, { 'Content-Security-Policy': "frame-ancestors 'none'", ...renew })
  }
  const file = normalize(join(rendererDir(), decodeURIComponent(path)))
  if (!file.startsWith(resolve(rendererDir()) + sep)) return send(res, 404, { error: 'Not found' })
  return serveFile(res, file)
}

// ---- the browser's WebSocket -------------------------------------------------------------

function onSocket(ws: WebSocket, device: Device): void {
  const client = { ws, device }
  sockets.add(client)
  ws.on('close', () => sockets.delete(client))
  ws.on('message', async (raw) => {
    let message: { id?: number; type?: string; channel?: string; args?: unknown[] }
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    // Revoked while connected: stop at once.
    if (!listDevices().some((d) => d.id === device.id)) return ws.close(4401, 'Revoked')
    const { status, body } = await runAction(String(message.channel), message.args ?? [], device)
    if (message.type === 'invoke' && message.id !== undefined) {
      ws.send(JSON.stringify({ id: message.id, ok: status === 200, ...(body as object) }))
    }
  })
}

function broadcast(channel: string, args: unknown[]): void {
  if (!sockets.size && !sseClients.size) return
  const data = JSON.stringify({ type: 'event', channel, args })
  for (const { ws } of sockets) if (ws.readyState === ws.OPEN) ws.send(data)
  for (const { res } of sseClients) res.write(`data: ${JSON.stringify({ channel, args })}\n\n`)
}

// ---- the preview relay ----------------------------------------------------------------

const HELPER_TAG = '<script src="/__vibeapp/preview-helper.js"></script>'

/** The project's running preview, relayed on a port of its own (so its absolute paths keep working). */
async function previewProxy(projectId: string): Promise<{ port: number; secure: boolean } | null> {
  const state = findPreview(projectId)?.getState()
  if (!running || state?.status !== 'running') return null
  const target = new URL(state.url).origin
  const existing = previewProxies.get(projectId)
  if (existing) {
    existing.target = target
    return { port: existing.port, secure: running.secure }
  }
  const { secure } = running
  const entry = { server: undefined as unknown as Server, port: 0, target }
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostOk(req, secure) || !deviceForToken(tokenFrom(req))) return send(res, 401, { error: 'Not paired.' })
    if (req.url === '/__vibeapp/preview-helper.js') return serveFile(res, remoteAsset('preview-helper.js'))
    const to = new URL(req.url ?? '/', entry.target)
    const headers = { ...req.headers, host: to.host }
    delete headers.cookie
    delete headers['accept-encoding'] // so HTML can be read and the helper added
    const upstream = httpRequest(to, { method: req.method, headers }, (up) => {
      const type = String(up.headers['content-type'] ?? '')
      const out = { ...up.headers }
      delete out['x-frame-options']
      delete out['content-security-policy']
      if (/text\/html/i.test(type)) {
        const chunks: Buffer[] = []
        up.on('data', (c: Buffer) => chunks.push(c))
        up.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf-8')
          html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${HELPER_TAG}`) : HELPER_TAG + html
          delete out['content-length']
          res.writeHead(up.statusCode ?? 200, out)
          res.end(html)
        })
      } else {
        res.writeHead(up.statusCode ?? 200, out)
        up.pipe(res)
      }
    })
    upstream.on('error', (err) => send(res, 502, { error: `The preview isn't answering: ${err.message}` }))
    req.pipe(upstream)
  }
  const server = secure ? createHttpsServer(await httpsOptions(), handler) : createHttpServer(handler)
  // Live reload (Vite and similar) talks over a WebSocket: tunnel it through.
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    if (!hostOk(req, secure) || !deviceForToken(tokenFrom(req))) {
      socket.destroy()
      return
    }
    const to = new URL(entry.target)
    const upstream = netConnect(Number(to.port || 80), to.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]
        if (/^(host|cookie)$/i.test(name)) continue
        lines.push(`${name}: ${req.rawHeaders[i + 1]}`)
      }
      lines.push(`Host: ${to.host}`)
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, running!.mode === 'lan' ? '0.0.0.0' : '127.0.0.1', () => done())
  })
  entry.server = server
  entry.port = (server.address() as { port: number }).port
  previewProxies.set(projectId, entry)
  return { port: entry.port, secure }
}

export function previewUrlFor(projectId: string): Promise<{ port: number; secure: boolean } | null> {
  return previewProxy(projectId)
}

// ---- start / stop / status ----------------------------------------------------------------

/** Brings the server in line with the settings (starts, stops or restarts it). */
export async function applyRemoteSettings(): Promise<void> {
  const { remoteAccess, remotePort } = getSettings()
  if (remoteAccess === 'off') return stopRemote()
  if (running && running.mode === remoteAccess && running.port === remotePort) return
  await stopRemote()
  lastError = undefined
  const secure = remoteAccess === 'lan'
  try {
    const server = secure
      ? createHttpsServer(await httpsOptions(), (req, res) => void handle(req, res, true).catch((e) => send(res, 500, { error: String(e) })))
      : createHttpServer((req, res) => void handle(req, res, false).catch((e) => send(res, 500, { error: String(e) })))
    const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const device = url.pathname === '/ws' ? deviceForToken(tokenFrom(req, url)) : null
      // A browser always sends its page's origin: it has to be VibeApp's own.
      const origin = req.headers.origin
      if (!device || !hostOk(req, secure) || (origin && origin !== ownOrigin(req, secure))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, device))
    })
    await new Promise<void>((done, fail) => {
      server.once('error', fail)
      server.listen(remotePort, secure ? '0.0.0.0' : '127.0.0.1', () => done())
    })
    running = { server, mode: remoteAccess, port: remotePort, secure, stopEvents: addEventSink(broadcast) }
    ensureApiToken(`${secure ? 'https' : 'http'}://127.0.0.1:${remotePort}`, secure ? (await certificate()).cert : undefined)
    installMcpServer()
    if (secure) void startTrustedCert()
  } catch (err) {
    lastError = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? `Port ${remotePort} is already in use. Choose another port.`
      : (err as Error).message
    running = undefined
  }
}

export async function stopRemote(): Promise<void> {
  const current = running
  running = undefined
  current?.stopEvents()
  stopTrustedCert()
  for (const { ws } of sockets) ws.close(1001, 'VibeApp remote access stopped')
  sockets.clear()
  for (const { res } of sseClients) res.end()
  sseClients.clear()
  for (const p of previewProxies.values()) {
    p.server.close()
    p.server.closeAllConnections?.()
  }
  previewProxies.clear()
  if (current) {
    // Without this, close() waits for every idle keep-alive connection to time out.
    const closed = new Promise<void>((done) => current.server.close(() => done()))
    current.server.closeAllConnections?.()
    await closed
  }
}

/** Puts VibeApp's MCP server where Claude Code can start it with plain Node (outside the app's archive). */
function installMcpServer(): void {
  const source = remoteAsset('vibeapp-mcp.cjs')
  if (!existsSync(source)) return
  try {
    copyFileSync(source, mcpScriptPath())
  } catch (err) {
    console.warn('Installing the VibeApp MCP server failed:', (err as Error).message)
  }
}

const mcpScriptPath = (): string => join(app.getPath('userData'), 'vibeapp-mcp.cjs')

export function remoteStatus(): RemoteStatus {
  const settings = getSettings()
  const online = new Set([...sockets].map((s) => s.device.id).concat([...sseClients].map((s) => s.device.id)))
  const scheme = running?.secure ? 'https' : 'http'
  const port = running?.port ?? settings.remotePort
  const trusted = running?.mode === 'lan' ? trustedCert() : undefined
  const trustedUrl = trusted ? `https://${trusted.name}:${port}` : undefined
  const urls = !running
    ? []
    : running.mode === 'lan'
      ? [
          // Tailscale's name has a certificate browsers trust (no warning, and phones can install the app).
          ...(trustedUrl ? [trustedUrl] : []),
          // The computer's name stays the same when its network address changes: best for bookmarks.
          `${scheme}://${hostname()}:${port}`,
          ...lanAddresses().map((ip) => `${scheme}://${ip}:${port}`),
          `${scheme}://localhost:${port}`
        ]
      : [`${scheme}://localhost:${port}`]
  return {
    running: !!running,
    mode: settings.remoteAccess,
    urls,
    pairingCode: running ? pairingCode() : '',
    readOnly: settings.remoteReadOnly,
    devices: listDevices().map((d) => ({ ...d, online: online.has(d.id) })),
    mcpCommand: `claude mcp add vibeapp -- node "${mcpScriptPath()}"`,
    ...(trustedUrl ? { trustedUrl } : {}),
    ...(running?.mode === 'lan' && !trustedUrl && trustedCertProblem() ? { trustedProblem: trustedCertProblem() } : {}),
    error: lastError
  }
}

/** Closes a revoked device's open connections straight away. */
export function disconnectDevice(id?: string): void {
  for (const s of [...sockets]) if (!id || s.device.id === id) s.ws.close(4401, 'Revoked')
  for (const c of [...sseClients]) if (!id || c.device.id === id) c.res.end()
}
