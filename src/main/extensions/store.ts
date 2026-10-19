import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import type { ExtensionDraft, ExtensionInfo } from '@shared/types'
import { RESERVED_ENV_NAMES, SECRET_NAME } from '@shared/secretPatterns'

// Extensions are tools (MCP servers) installed once and offered to Claude and
// Codex in every project. The list lives in the app's data folder; the values
// of any keys they need are encrypted with the Windows account's key, like
// project secrets.

interface StoredExtension extends Omit<ExtensionInfo, 'envNames' | 'needsKeys'> {
  needsKeys?: string[]
  /** Base64 of the safeStorage-encrypted JSON of the env values. */
  env: string
}

function filePath(): string {
  return join(app.getPath('userData'), 'extensions.json')
}

function readAll(): StoredExtension[] {
  const file = filePath()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { extensions?: StoredExtension[] }
    return Array.isArray(parsed.extensions) ? parsed.extensions : []
  } catch {
    return []
  }
}

function writeAll(list: StoredExtension[]): void {
  writeFileSync(filePath(), JSON.stringify({ extensions: list }, null, 2), 'utf-8')
}

function encryptEnv(env: Record<string, string>): string {
  if (Object.keys(env).length === 0) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("This computer can't encrypt keys right now, so they weren't saved.")
  }
  return safeStorage.encryptString(JSON.stringify(env)).toString('base64')
}

function decryptEnv(stored: string): Record<string, string> {
  if (!stored) return {}
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(stored, 'base64'))) as Record<string, string>
  } catch {
    return {}
  }
}

function cleanEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(env)) {
    const name = rawName.trim()
    if (!name || !value.trim()) continue
    if (!SECRET_NAME.test(name)) throw new Error(`"${name}" isn't a valid variable name (letters, numbers, underscores).`)
    if (RESERVED_ENV_NAMES.test(name)) throw new Error(`${name} is used by the system and can't be set here.`)
    out[name] = value.trim()
  }
  return out
}

function toInfo(e: StoredExtension): ExtensionInfo {
  const { env, ...rest } = e
  const have = Object.keys(decryptEnv(env))
  return { ...rest, envNames: have, needsKeys: (e.needsKeys ?? []).filter((n) => !have.includes(n)) }
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'tool'
  )
}

/** A name unused by any installed extension, for choosing a folder before adding it. */
export function freeId(name: string): string {
  const taken = new Set(readAll().map((e) => e.id))
  let id = slug(name)
  for (let n = 2; taken.has(id); n++) id = `${slug(name)}_${n}`
  return id
}

export function listExtensions(): ExtensionInfo[] {
  return readAll().map(toInfo)
}

export function addExtension(draft: ExtensionDraft): ExtensionInfo {
  const name = draft.name.trim()
  const command = draft.command.trim()
  if (!name) throw new Error('Give the extension a name.')
  if (!command) throw new Error('Say which program runs the extension.')
  const list = readAll()
  const id = freeId(name)
  const stored: StoredExtension = {
    id,
    name,
    description: draft.description?.trim() ?? '',
    command,
    args: draft.args.map((a) => a.trim()).filter(Boolean),
    instructions: draft.instructions?.trim() ?? '',
    enabled: draft.enabled ?? true,
    catalogId: draft.catalogId,
    needsKeys: draft.needsKeys,
    folder: draft.folder,
    env: encryptEnv(cleanEnv(draft.env))
  }
  writeAll([...list, stored])
  return toInfo(stored)
}

export function setExtensionEnabled(id: string, enabled: boolean): void {
  writeAll(readAll().map((e) => (e.id === id ? { ...e, enabled } : e)))
}

export function setExtensionEnv(id: string, env: Record<string, string>): void {
  const supplied = cleanEnv(env)
  writeAll(
    readAll().map((e) => {
      if (e.id !== id) return e
      // New values are added to the keys already saved.
      const clean = { ...decryptEnv(e.env), ...supplied }
      const encrypted = encryptEnv(clean)
      // An extension waiting for its keys switches on once it has them all.
      const complete = (e.needsKeys ?? []).length > 0 && (e.needsKeys ?? []).every((n) => n in clean)
      return { ...e, env: encrypted, enabled: complete ? true : e.enabled }
    })
  )
}

/** Where agent-built servers are kept: inside VibeApp's data, so they outlive any one project. */
export function extensionsDir(): string {
  return join(app.getPath('userData'), 'extensions')
}

export function removeExtension(id: string): void {
  const list = readAll()
  const gone = list.find((e) => e.id === id)
  writeAll(list.filter((e) => e.id !== id))
  // Only ever delete a folder VibeApp itself created.
  if (gone?.folder && resolve(gone.folder).startsWith(resolve(extensionsDir()) + sep)) {
    try {
      rmSync(gone.folder, { recursive: true, force: true })
    } catch (err) {
      // Removed from the list either way; a locked folder is only leftover disk space.
      console.warn('Removing extension files failed:', (err as Error).message)
    }
  }
}

/** An enabled extension, ready to hand to an agent. */
export interface ActiveExtension {
  /** MCP server name (prefixed so it can't clash with VibeApp's own or a project's). */
  server: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  instructions: string
}

/** On Windows, npx and similar launchers are .cmd scripts and need cmd.exe to start. */
export function launcher(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === 'win32' && /^(npx|npm|pnpm|yarn|uvx|uv)$/i.test(command)) {
    return { command: 'cmd', args: ['/c', command, ...args] }
  }
  return { command, args }
}

const firstExisting = (paths: (string | undefined)[]): string | undefined =>
  paths.find((p): p is string => !!p && existsSync(p))

function windowsBrowser(vendorPath: string): string | undefined {
  return firstExisting(
    [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].map((root) =>
      root ? join(root, vendorPath) : undefined
    )
  )
}

/**
 * The Playwright tool server, adjusted to work on this computer: it looks for
 * Google Chrome by default and fails outright without it, so use Microsoft
 * Edge (part of Windows) when Chrome isn't there; a fresh profile each run, so
 * Claude and Codex can't lock each other out of a shared one; and its
 * screenshots and page snapshots kept out of the user's project.
 */
export function withBrowserFixes(args: string[]): string[] {
  if (!args.some((a) => /@playwright\/mcp\b/.test(a))) return args
  const out = [...args]
  const has = (flag: string): boolean => out.some((a) => a === flag || a.startsWith(`${flag}=`))
  if (process.platform === 'win32' && !has('--browser')) {
    const chrome = windowsBrowser(join('Google', 'Chrome', 'Application', 'chrome.exe'))
    const edge = windowsBrowser(join('Microsoft', 'Edge', 'Application', 'msedge.exe'))
    if (!chrome && edge) out.push('--browser', 'msedge')
  }
  if (!has('--isolated') && !has('--user-data-dir')) out.push('--isolated')
  if (!has('--output-dir')) out.push('--output-dir', join(app.getPath('temp'), 'vibeapp-playwright').replace(/\\/g, '/'))
  return out
}

function toActive(e: StoredExtension): ActiveExtension {
  return {
    server: `ext_${e.id}`,
    name: e.name,
    ...launcher(e.command, withBrowserFixes(e.args)),
    env: decryptEnv(e.env),
    instructions: e.instructions
  }
}

export function activeExtensions(): ActiveExtension[] {
  return readAll()
    .filter((e) => e.enabled)
    .map(toActive)
}

/** One installed extension, ready to start, whether or not it's switched on (for checking it). */
export function extensionLaunch(id: string): ActiveExtension | undefined {
  const found = readAll().find((e) => e.id === id)
  return found ? toActive(found) : undefined
}

/** The part of the agents' instructions that describes the installed extensions. */
export function extensionInstructions(list: ActiveExtension[] = activeExtensions()): string {
  if (!list.length) return ''
  const lines = list.map((e) => `- ${e.name} (tools from the "${e.server}" server)${e.instructions ? `: ${e.instructions}` : ''}`)
  return `## Extensions the user has installed\nThese extra tools are available in every project:\n${lines.join('\n')}`
}
