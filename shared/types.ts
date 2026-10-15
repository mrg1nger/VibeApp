import type { AgentBalance } from './balance'

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

/**
 * One step in a Codex hand-off. A step that takes time is reported twice
 * with the same id: once when it starts, once when it finishes (done: true).
 */
export interface DelegationActivity {
  id: string
  step: 'say' | 'edit' | 'run' | 'tool'
  /** What happened, in plain words ("Created utils.js", "npm test"). */
  text: string
  /** The whole command, when `text` shows only its first statement. */
  full?: string
  /** Output or extra detail (a command's output, trimmed). */
  detail?: string
  done: boolean
  /** For commands and tools: whether it worked. */
  ok?: boolean
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
  | { type: 'tool_call'; toolUseId: string; name: string; input: unknown; friendlyLabel: string; /** Set when a helper agent made the call; the id of the Agent call that started it. */ parentToolUseId?: string }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; summary: string; raw: unknown; parentToolUseId?: string }
  | { type: 'delegation_started'; toolUseId: string; subtaskPrompt: string }
  | { type: 'delegation_progress'; toolUseId: string; note: string }
  | { type: 'delegation_result'; toolUseId: string; ok: boolean; summary: string }
  | { type: 'task_progress'; note: string }
  | { type: 'turn_complete' }
  | { type: 'error'; message: string }
  /** The user pressed Stop; the turn ended early on purpose. */
  | { type: 'stopped' }
  /** Claude's plan limit was reached; it can't run until `resetsAt` (epoch ms, if known). */
  | { type: 'claude_limit'; resetsAt: number | null; message: string }
  /** Codex is handling the request directly because Claude is out. */
  | { type: 'takeover_started'; resetsAt: number | null }
  /** Claude is out; the user can choose to let Codex handle the request. */
  | { type: 'takeover_offer'; text: string; resetsAt: number | null }
  /** One step of what Codex is doing during a hand-off (shown as a live feed under its card). */
  | { type: 'delegation_activity'; activity: DelegationActivity }
  /** What one request cost (tokens), shown quietly under the reply. */
  | { type: 'usage'; steps: number; fresh: number; cached: number; output: number; model?: string }
  /** The conversation was moved into a fresh Claude session to keep it fast. */
  | { type: 'session_rotated'; contextTokens: number; /** What was carried into the new session. */ summary?: string }
  /** Smart model switching picked a model for this message. */
  | { type: 'route'; label: string; reason: string; detail?: string }
  /** Codex started reviewing the changes Claude just made. */
  | { type: 'review_started' }
  | { type: 'review_result'; ok: boolean; summary: string; findings: ReviewFinding[]; fixing: boolean }
  /** A secret key was written into a project file. */
  | { type: 'secret_leak'; leaks: SecretLeak[] }

export type TalkAgent = 'claude' | 'codex'

export interface TalkMessage {
  role: 'user' | 'assistant'
  text: string
  /** Which agent wrote an assistant message. */
  agent?: TalkAgent
  at: number
}

export interface TalkConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: TalkMessage[]
}

export interface TalkSummary {
  id: string
  title: string
  updatedAt: number
}

/** A tool (an MCP server plus instructions) installed once and offered to Claude and Codex in every project. */
export interface ExtensionInfo {
  id: string
  name: string
  description: string
  command: string
  args: string[]
  /** Names only; the values stay in the encrypted store. */
  envNames: string[]
  instructions: string
  enabled: boolean
  catalogId?: string
  /** Keys it needs that haven't been supplied yet (it stays off until they are). */
  needsKeys: string[]
  /** Where an agent-built server's files were copied to (inside VibeApp's data folder). */
  folder?: string
}

export interface ExtensionDraft {
  name: string
  description?: string
  command: string
  args: string[]
  env: Record<string, string>
  instructions?: string
  catalogId?: string
  needsKeys?: string[]
  folder?: string
  enabled?: boolean
}

export interface ExtensionCatalogItem {
  id: string
  name: string
  description: string
  command: string
  args: string[]
  /** Keys the user has to supply (name shown as the label). */
  envNeeded: { name: string; label: string }[]
  instructions: string
  /** Program that must be installed for it to run. */
  requires: 'node'
}

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

export const MEMORY_CATEGORIES = ['about', 'setup', 'decision', 'preference', 'gotcha', 'other'] as const
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

export interface MemoryFact {
  id: string
  text: string
  category: MemoryCategory
  /** Key facts go into Claude's and Codex's instructions up front; the rest are searched when needed. */
  key: boolean
  source: 'claude' | 'codex' | 'user' | 'tidy' | 'scribe'
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
  useCount: number
  /** Set when a fact was forgotten (by an agent, the tidy-up, or merged into another); it can be restored. */
  forgottenAt: string | null
  forgottenReason: string | null
}

export interface MemoryTidyResult {
  categorized: number
  merged: number
  outdated: number
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
  /** How work leans between Claude and Codex ("auto" follows which plan has more left). */
  agentBalance: AgentBalance
  /** When Claude's plan limit is reached: let Codex take the request, ask first, or just report it. */
  limitTakeover: 'auto' | 'ask' | 'off'
  /** Send plain questions typed in Build mode to the cheaper Ask path. */
  autoAsk: boolean
  /** Conversation size (tokens) past which a long chat moves to a fresh session, when that's switched on. */
  rotateAtTokens: number
  /** null = whatever the Claude Code account/settings default to. */
  claudeModel: string | null
  /** null = whatever ~/.codex/config.toml defaults to. */
  codexModel: string | null
  themeId: string
  /** Pick a cheaper Claude model for small edits and when plan usage runs low. */
  smartRouting: boolean
  /** Let Haiku label each request (size, and how much suits Codex) instead of keyword rules. */
  aiRouting: boolean
  /** Keep a one-line summary of every source file, so agents can find where things live. */
  codeMap: boolean
  /** A background Haiku pass saves lasting facts after each request, so the agents don't spend a turn on it. */
  autoMemory: boolean
  /** Start a fresh Claude session (seeded from memory and a summary) when the conversation gets very long. */
  freshSessions: boolean
  /** Write the project's key facts into an AGENTS.md block, for other tools opened in the folder. */
  exportAgentsFile: boolean
  /** Let smart switching go above the chosen model (to Opus) for complex requests. Off: the chosen model is a ceiling. */
  stepUpForComplex: boolean
  /** Have Codex review Claude's code changes after each request. */
  codexReview: boolean
}

/** Where tokens went over a period, by kind of work. */
export interface UsageSummaryRow {
  kind: string
  runs: number
  fresh: number
  cached: number
  output: number
}

export interface ModelOption {
  value: string
  displayName: string
  description: string
}
