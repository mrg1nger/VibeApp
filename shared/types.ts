export type CliName = 'claude' | 'codex'

export type AuthStatus = 'checking' | 'logged_in' | 'logged_out' | 'not_installed'

export interface CliStatus {
  cli: CliName
  status: AuthStatus
  detail?: string
  /**
   * The check didn't get a real answer (timed out on a busy machine, say).
   * `status` is only a guess then; keep whatever was known before.
   */
  inconclusive?: boolean
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
  /** The user pressed Stop; the turn ended early on purpose. */
  | { type: 'stopped' }
  /** Smart model switching picked a model for this message. */
  | { type: 'route'; label: string; reason: string }
  /** Codex started reviewing the changes Claude just made. */
  | { type: 'review_started' }
  | { type: 'review_result'; ok: boolean; summary: string; findings: ReviewFinding[]; fixing: boolean }
  /** A secret key was written into a project file. */
  | { type: 'secret_leak'; leaks: SecretLeak[] }

export interface SecretSummary {
  name: string
  /** Masked, e.g. "••••a1b2". */
  preview: string
}

/** A secret found somewhere it would leak (project files that git or a deploy would pick up). */
export interface SecretLeak {
  file: string
  line: number
  /** The stored secret's name, or the kind of key recognized. */
  what: string
}

export interface ReviewFinding {
  severity: 'high' | 'medium' | 'low'
  file: string
  line: number | null
  title: string
  detail: string
}

/** An image the user pasted, dropped, or picked for a message. */
export interface ImageAttachment {
  name?: string
  mediaType: string
  /** Base64, no data: prefix. */
  data: string
}

/** An element the user pointed at in the live preview. */
export interface PickedElement {
  pageUrl: string
  selector: string
  tag: string
  text: string
  html: string
}

export type PreviewState =
  | { status: 'idle' }
  | { status: 'none'; message: string }
  | { status: 'starting'; command: string }
  | { status: 'running'; command: string; url: string }
  | { status: 'crashed'; command: string; exitCode: number | null }

/** A problem spotted in the running app (server output or the page itself). */
export interface PreviewProblem {
  source: 'server' | 'page'
  message: string
}

export interface ConfirmationRequest {
  id: string
  toolName: string
  input: unknown
  /** Human-readable description of what's being asked, e.g. "Claude wants to edit ~/x.txt". */
  reason: string
  /** Set when Claude is asking the user questions (AskUserQuestion) rather than asking permission. */
  questions?: UserQuestion[]
}

export interface UserQuestion {
  question: string
  /** Short label, e.g. "Auth method". */
  header: string
  options: { label: string; description: string }[]
  multiSelect: boolean
}

/** Question text -> chosen label(s) (comma-separated for multi-select) or the user's own words. */
export type QuestionAnswers = Record<string, string>

export interface ProjectRecord {
  id: string
  path: string
  name: string
  lastOpened: string
  sdkSessionId?: string
  goNutzMode?: boolean
  /** Where the app was last published on Vercel. */
  deployUrl?: string
}

export interface PublishStatus {
  ghInstalled: boolean
  ghLoggedIn: boolean
  vercelLoggedIn: boolean
  /** The GitHub repo this project pushes to, if any. */
  githubUrl: string | null
  deployUrl: string | null
  secretNames: string[]
  /** Secrets sitting in files that would be uploaded; publishing is blocked until they're gone. */
  leaks: SecretLeak[]
  nodeInstalled: boolean
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
  /** Snapshot of the project's files taken just before this message (for undo). */
  snapshot?: string
  /** Short description of an element the user pointed at, shown with the message. */
  attachment?: string
  /** Thumbnails (data: URLs) of images attached to the message. */
  images?: string[]
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
  /** Pick a cheaper Claude model for small edits and when plan usage runs low. */
  smartRouting: boolean
  /** Have Codex review Claude's code changes after each request. */
  codexReview: boolean
}

export interface ModelOption {
  value: string
  displayName: string
  description: string
}
