import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { SecretSummary } from '@shared/types'
import { HIDDEN_FROM_AGENTS, RESERVED_ENV_NAMES, SECRET_NAME } from '@shared/secretPatterns'

// Per-project secrets, encrypted with the OS user account's key (DPAPI on
// Windows) and stored outside the project, so they can't end up in git, a
// published site, or a chat. Apps get them as environment variables.

function vaultPath(projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('Invalid project id.')
  const dir = join(app.getPath('userData'), 'secrets')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, `${projectId}.bin`)
}

function load(projectId: string): Record<string, string> {
  const file = vaultPath(projectId)
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(safeStorage.decryptString(readFileSync(file))) as Record<string, string>
  } catch {
    throw new Error("This project's secrets couldn't be unlocked (were they created by another Windows user?).")
  }
}

function save(projectId: string, secrets: Record<string, string>): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("This computer can't encrypt secrets right now, so they weren't saved.")
  }
  const file = vaultPath(projectId)
  if (Object.keys(secrets).length === 0) {
    rmSync(file, { force: true })
    return
  }
  writeFileSync(file, safeStorage.encryptString(JSON.stringify(secrets)))
}

function mask(value: string): string {
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`
}

export function listSecrets(projectId: string): SecretSummary[] {
  return Object.entries(load(projectId))
    .map(([name, value]) => ({ name, preview: mask(value) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function setSecret(projectId: string, rawName: string, value: string): SecretSummary {
  const name = rawName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  if (!SECRET_NAME.test(name)) throw new Error('Use a name like OPENAI_API_KEY (letters, numbers, underscores).')
  if (RESERVED_ENV_NAMES.test(name)) throw new Error(`${name} is used by the system and can't be a secret.`)
  if (!value.trim()) throw new Error('The secret is empty.')
  const secrets = load(projectId)
  secrets[name] = value.trim()
  save(projectId, secrets)
  return { name, preview: mask(secrets[name]) }
}

export function deleteSecret(projectId: string, name: string): void {
  const secrets = load(projectId)
  delete secrets[name]
  save(projectId, secrets)
}

/** All secrets, for the user's app (preview server, deployments). */
export function secretEnv(projectId: string): Record<string, string> {
  try {
    return load(projectId)
  } catch {
    return {}
  }
}

/** Secrets safe to hand to Claude/Codex processes (see HIDDEN_FROM_AGENTS). */
export function agentSecretEnv(projectId: string): Record<string, string> {
  return Object.fromEntries(Object.entries(secretEnv(projectId)).filter(([name]) => !HIDDEN_FROM_AGENTS.test(name)))
}

/** Values to look for when checking files for leaked secrets. */
export function secretValues(projectId: string): { name: string; value: string }[] {
  return Object.entries(secretEnv(projectId))
    .filter(([, value]) => value.length >= 8)
    .map(([name, value]) => ({ name, value }))
}
