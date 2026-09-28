export type CliName = 'claude' | 'codex'

export type AuthStatus = 'checking' | 'logged_in' | 'logged_out' | 'not_installed'

export interface CliStatus {
  cli: CliName
  status: AuthStatus
  detail?: string
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
}

export interface ProjectRecord {
  id: string
  path: string
  name: string
  lastOpened: string
  sdkSessionId?: string
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
