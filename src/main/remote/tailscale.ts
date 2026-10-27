import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createSecureContext, type SecureContext } from 'tls'

// A trusted certificate from Tailscale (Let's Encrypt, for this computer's
// name on the tailnet, e.g. devbox.tail1234.ts.net). Browsers accept it without
// a warning, which phones need to install VibeApp as an app. Needs MagicDNS and
// "HTTPS Certificates" turned on in the Tailscale admin page; nothing else changes:
// the address is only reachable from your own Tailscale devices.

export interface TrustedCert {
  /** This computer's Tailscale name, e.g. devbox.tail1234.ts.net. */
  name: string
  context: SecureContext
}

let current: TrustedCert | undefined
/** Why there is no trusted certificate (shown in Settings), or undefined while it's fine or unknown. */
let problem: string | undefined
let timer: NodeJS.Timeout | undefined
let fetching: Promise<void> | undefined

function tailscaleExe(): string {
  const installed = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')
  return existsSync(installed) ? installed : 'tailscale'
}

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((done, fail) => {
    execFile(tailscaleExe(), args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(Object.assign(err, { stderr: String(stderr ?? '') }))
      else done(String(stdout))
    })
  })
}

async function fetchCert(): Promise<void> {
  let name: string | undefined
  try {
    const status = JSON.parse(await run(['status', '--json'], 15_000)) as {
      BackendState?: string
      CertDomains?: string[] | null
      Self?: { DNSName?: string }
    }
    if (status.BackendState && status.BackendState !== 'Running') {
      problem = "Tailscale isn't connected on this computer."
      return
    }
    name = status.CertDomains?.[0]
    if (!name) {
      problem = status.Self?.DNSName
        ? 'Turn on "HTTPS Certificates" (and MagicDNS) in the Tailscale admin page, under DNS, to get a trusted address.'
        : "Tailscale didn't report a name for this computer."
      return
    }
  } catch (err) {
    // Not installed (or not running): nothing to do, and nothing worth nagging about.
    problem = (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : "Tailscale didn't answer."
    return
  }
  const dir = join(app.getPath('userData'), 'remote-tailscale')
  mkdirSync(dir, { recursive: true })
  const certFile = join(dir, 'cert.pem')
  const keyFile = join(dir, 'key.pem')
  try {
    // Tailscale keeps its own copy and only asks for a new one when this one is getting old.
    await run(['cert', '--cert-file', certFile, '--key-file', keyFile, name], 120_000)
    const context = createSecureContext({ cert: readFileSync(certFile), key: readFileSync(keyFile) })
    current = { name, context }
    problem = undefined
  } catch (err) {
    const detail = String((err as { stderr?: string }).stderr ?? '').trim().split('\n').pop()
    problem = `Tailscale couldn't provide a certificate${detail ? `: ${detail}` : '.'}`
    // A previous certificate stays in use while it lasts.
  }
}

/** Gets (or renews) the certificate. Runs in the background; checks again every 12 hours. */
export function startTrustedCert(): Promise<void> {
  if (!timer) {
    timer = setInterval(() => void refresh(), 12 * 60 * 60 * 1000)
    timer.unref()
  }
  return refresh()
}

function refresh(): Promise<void> {
  fetching ??= fetchCert().finally(() => (fetching = undefined))
  return fetching
}

export function stopTrustedCert(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

export function trustedCert(): TrustedCert | undefined {
  return current
}

export function trustedCertProblem(): string | undefined {
  return problem
}

/** For an HTTPS server: the Tailscale certificate when the browser asked for that name, otherwise VibeApp's own. */
export function sniCallback(servername: string, done: (err: Error | null, ctx?: SecureContext) => void): void {
  done(null, current && servername.toLowerCase() === current.name.toLowerCase() ? current.context : undefined)
}
