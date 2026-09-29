export type CliName = 'claude' | 'codex'

export type AuthStatus = 'checking' | 'logged_in' | 'logged_out' | 'not_installed'

export interface CliStatus {
  cli: CliName
  status: AuthStatus
  detail?: string
}

export interface UsageWindow {
  label: string
  /** Percentage of this plan window already used, 0-100. */
  usedPercent: number
  /** When the window resets, in epoch ms, if known. */
  resetsAt: number | null
}

/** Plan usage for one CLI's signed-in account (subscription windows, not raw token counts). */
export interface UsageSnapshot {
  cli: CliName
  status: 'ok' | 'unavailable' | 'error'
  plan?: string
  windows: UsageWindow[]
  /** Why usage isn't shown (status 'unavailable' or 'error'). */
  message?: string
  fetchedAt: number
}

export type VibeEvent =
  | { type: 'assistant_text'; text: string; partial: boolean }
  | { type: 'tool_call'; toolUseId: string; name: string; input: unknown; friendlyLabel: string }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; summary: string; raw: unknown }
  | { type: 'delegation_started'; toolUseId: string; subtaskPrompt: string }
  | { type: 'delegation_progress'; toolUseId: string; note: string }
  | { type: 'delegation_result'; toolUseId: string; ok: boolean; summary: string }
  | { type: 'task_progress'; note: string }
  | { type: 'turn_complete' }
  | { type: 'error'; message: string }

export interface ConfirmationRequest {
  id: string
  toolName: string
  input: unknown
  /** Human-readable description of what's being asked, e.g. "Claude wants to edit ~/x.txt". */
  reason: string
}

export interface ProjectRecord {
  id: string
  path: string
  name: string
  lastOpened: string
  sdkSessionId?: string
  goNutzMode?: boolean
}

export interface CheckpointRecord {
  hash: string
  message: string
  date: string
}

export interface TranscriptEntry {
  direction: 'user' | 'event'
  text?: string
  event?: VibeEvent
}

export interface MemoryFact {
  id: string
  text: string
  createdAt: string
  source: 'claude' | 'codex' | 'user'
}

export type MemoryScope = 'project' | 'global'

/** Every CSS variable a theme may set; see the :root block in styles.css. */
export const THEME_VARS = [
  'font',
  'radius',
  'bg',
  'bg-image',
  'surface',
  'surface-raised',
  'surface-sunken',
  'border',
  'text',
  'text-muted',
  'accent',
  'accent-text',
  'accent-glow',
  'title',
  'user-bubble',
  'success-bg',
  'success-text',
  'warning-bg',
  'warning-text',
  'danger',
  'danger-bg',
  'danger-text',
  'delegation-bg',
  'delegation-text',
  'overlay'
] as const

export type ThemeVar = (typeof THEME_VARS)[number]

export interface ThemeDefinition {
  id: string
  name: string
  description?: string
  source: 'built-in' | 'custom' | 'generated'
  vars: Record<ThemeVar, string>
  /** Optional replacement for "Claude is working…". */
  thinkingLabel?: string
}

export interface AppSettings {
  /** null = whatever the Claude Code account/settings default to. */
  claudeModel: string | null
  /** null = whatever ~/.codex/config.toml defaults to. */
  codexModel: string | null
  themeId: string
}

export interface ModelOption {
  value: string
  displayName: string
  description: string
}
