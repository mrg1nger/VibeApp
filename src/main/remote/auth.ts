import { app } from 'electron'
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// Who may use Remote access. A browser or tool pairs once with the code shown
// in VibeApp's Settings and gets a long random token; only a hash of it is
// stored. Wrong codes are rate-limited per address. The local API token (for
// VibeApp's own MCP server on this computer) lives in a separate file that the
// MCP server reads.

interface StoredDevice {
  id: string
  name: string
  tokenHash: string
  readOnly: boolean
  createdAt: string
  lastSeen: string | null
}

interface AuthFile {
  pairingCode: string
  devices: StoredDevice[]
}

export interface Device {
  id: string
  name: string
  readOnly: boolean
  createdAt: string
  lastSeen: string | null
}

const MAX_FAILURES = 5
const FAILURE_WINDOW_MS = 10 * 60_000
const LOCKOUT_MS = 10 * 60_000

const authPath = (): string => join(app.getPath('userData'), 'remote.json')
/** Read by the MCP server, which runs as a separate process on this computer. */
export const apiFilePath = (): string => join(app.getPath('userData'), 'remote-api.json')

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function read(): AuthFile {
  try {
    if (existsSync(authPath())) {
      const parsed = JSON.parse(readFileSync(authPath(), 'utf-8')) as Partial<AuthFile>
      if (parsed.pairingCode && Array.isArray(parsed.devices)) return parsed as AuthFile
    }
  } catch {
    // unreadable: start again (everyone re-pairs)
  }
  const fresh: AuthFile = { pairingCode: newCode(), devices: [] }
  write(fresh)
  return fresh
}

function write(data: AuthFile): void {
  writeFileSync(authPath(), JSON.stringify(data, null, 2), 'utf-8')
}

function toDevice(d: StoredDevice): Device {
  return { id: d.id, name: d.name, readOnly: d.readOnly, createdAt: d.createdAt, lastSeen: d.lastSeen }
}

export function pairingCode(): string {
  return read().pairingCode
}

export function rotatePairingCode(): string {
  const data = read()
  data.pairingCode = newCode()
  write(data)
  return data.pairingCode
}

export function listDevices(): Device[] {
  return read().devices.map(toDevice)
}

export function revokeDevice(id: string): void {
  const data = read()
  data.devices = data.devices.filter((d) => d.id !== id)
  write(data)
}

export function revokeAll(): void {
  const data = read()
  data.devices = []
  write(data)
}

const failures = new Map<string, number[]>()
const lockedUntil = new Map<string, number>()

export class PairingError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

/** Exchanges the pairing code for a device token. Throws PairingError on a wrong code or too many tries. */
export function pair(code: string, name: string, address: string, readOnly: boolean): { token: string; device: Device } {
  const now = Date.now()
  if ((lockedUntil.get(address) ?? 0) > now) {
    throw new PairingError('Too many wrong codes. Try again in a few minutes.', 429)
  }
  const data = read()
  const given = Buffer.from(String(code).trim())
  const expected = Buffer.from(data.pairingCode)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    const recent = (failures.get(address) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS)
    recent.push(now)
    failures.set(address, recent)
    if (recent.length >= MAX_FAILURES) {
      lockedUntil.set(address, now + LOCKOUT_MS)
      failures.delete(address)
    }
    throw new PairingError("That code isn't right. Check the code in VibeApp's Settings.", 401)
  }
  failures.delete(address)
  const token = randomBytes(32).toString('base64url')
  const device: StoredDevice = {
    id: randomUUID(),
    name: String(name || 'Browser').slice(0, 60),
    tokenHash: hash(token),
    readOnly,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString()
  }
  data.devices.push(device)
  // A code is good for one pairing: the next device needs the new one.
  data.pairingCode = newCode()
  write(data)
  return { token, device: toDevice(device) }
}

const lastTouched = new Map<string, number>()

/** The device a token belongs to, or null. Notes when it was last seen (at most once a minute). */
export function deviceForToken(token: string | undefined | null): Device | null {
  if (!token) return null
  const want = hash(token)
  const data = read()
  const found = data.devices.find((d) => {
    const a = Buffer.from(d.tokenHash)
    const b = Buffer.from(want)
    return a.length === b.length && timingSafeEqual(a, b)
  })
  if (!found) return null
  if (Date.now() - (lastTouched.get(found.id) ?? 0) > 60_000) {
    lastTouched.set(found.id, Date.now())
    found.lastSeen = new Date().toISOString()
    write(data)
  }
  return toDevice(found)
}

/**
 * The token VibeApp's own MCP server uses (a device named "Claude Code tools"),
 * written where that server, running on this computer as the same user, reads it.
 */
export function ensureApiToken(url: string, ca?: string): void {
  let existing: { url?: string; token?: string; ca?: string } = {}
  try {
    existing = JSON.parse(readFileSync(apiFilePath(), 'utf-8'))
  } catch {
    // none yet
  }
  if (existing.token && deviceForToken(existing.token)) {
    if (existing.url !== url || existing.ca !== ca) writeFileSync(apiFilePath(), JSON.stringify({ url, token: existing.token, ca }), 'utf-8')
    return
  }
  const data = read()
  const token = randomBytes(32).toString('base64url')
  data.devices.push({
    id: randomUUID(),
    name: 'Claude Code tools (this computer)',
    tokenHash: hash(token),
    readOnly: false,
    createdAt: new Date().toISOString(),
    lastSeen: null
  })
  write(data)
  writeFileSync(apiFilePath(), JSON.stringify({ url, token, ca }), 'utf-8')
}

// ---- what remote callers may do ------------------------------------------------------

/** Actions that only read. A read-only device (or a read-only server) may call only these. */
const READ_CHANNELS = new Set([
  'vibe:ping',
  'vibe:auth:check',
  'vibe:auth:checkNode',
  'vibe:project:list',
  'vibe:chat:loadTranscript',
  'vibe:chat:isGoNutzMode',
  'vibe:chat:contextSize',
  'vibe:git:hasChanges',
  'vibe:git:history',
  'vibe:memory:list',
  'vibe:memory:brief',
  'vibe:settings:get',
  'vibe:models:claude',
  'vibe:themes:list',
  'vibe:usage:get',
  'vibe:usage:summary',
  'vibe:preview:state',
  'vibe:preview:log',
  'vibe:secrets:list',
  'vibe:publish:status',
  'vibe:talk:list',
  'vibe:talk:load',
  'vibe:extensions:list',
  'vibe:remote:previewUrl',
  'vibe:fs:listDirs'
])

/** Managing Remote access itself stays on the computer, so a remote device can't widen its own access. */
const DESKTOP_ONLY = /^vibe:remote:(?!previewUrl$)/
const REMOTE_SETTINGS = ['remoteAccess', 'remotePort', 'remoteReadOnly'] as const

export interface CallCheck {
  allowed: boolean
  reason?: string
  /** Arguments to use instead (settings changes have remote-access keys removed). */
  args?: unknown[]
}

export function checkRemoteCall(channel: string, args: unknown[], readOnly: boolean): CallCheck {
  if (DESKTOP_ONLY.test(channel)) {
    return { allowed: false, reason: 'Remote access settings can only be changed on the computer running VibeApp.' }
  }
  if (readOnly && !READ_CHANNELS.has(channel)) {
    return { allowed: false, reason: 'This connection is read-only.' }
  }
  if (channel === 'vibe:settings:update' && args[0] && typeof args[0] === 'object') {
    const patch = { ...(args[0] as Record<string, unknown>) }
    for (const key of REMOTE_SETTINGS) delete patch[key]
    return { allowed: true, args: [patch, ...args.slice(1)] }
  }
  return { allowed: true }
}
