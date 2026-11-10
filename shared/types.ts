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
  /** Why usage isn't shown (status 'unavailable' or 'error'), or why shown numbers are old. */
  message?: string
  fetchedAt: number
  /** The last real numbers, kept because the latest check failed. */
  stale?: boolean
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
  /** The conversation is being compacted (shrunk in place) to keep it fast. */
  /** Plan mode: Claude proposed a plan, waiting for the user to approve, change or cancel it. */
  | { type: 'plan_proposed'; toolUseId: string; plan: string; steps: { text: string; who?: 'claude' | 'codex' }[]; by?: 'claude' | 'codex' }
  /** Building an approved plan ended: how many of its steps were reported, and whether it was stopped. */
  | { type: 'plan_finished'; total: number; tracked: number; stopped: boolean }
  /** A big request was sent in Build: VibeApp asks whether to plan it first. */
  | { type: 'plan_suggested'; text: string }
  /** The Deploy button ran (shown in the chat so the history says when it went live). */
  | { type: 'deploy_result'; name: string; ok: boolean; seconds: number; failedStep?: string; detail?: string; rolledBack?: boolean; stopped?: boolean }
  /** Claude wrote or changed the deploy recipe: the user should check it. */
  | { type: 'deploy_recipe_ready'; name: string; steps: number }
  /** A schedule started (a request's own message follows in the chat as usual). */
  | { type: 'scheduled_run'; scheduleId: string; name: string; what: string; text?: string }
  /** A schedule ran something with no AI (Deploy, a site check) or was skipped: a line in the chat. */
  | { type: 'schedule_note'; name: string; text: string }
  /** Claude wrote a schedule: the user should check it and turn it on. */
  | { type: 'schedule_ready'; scheduleId: string; name: string; summary: string }
  /** Something about the GitHub copy worth a line in the chat (a backup that couldn't go, newer work fetched). */
  | { type: 'github_note'; text: string }
  /** What the user decided about a proposed plan (kept so the chat shows it after reopening). */
  | { type: 'plan_decided'; toolUseId: string; decision: 'approved' | 'revised' | 'cancelled' }
  /** Building an approved plan: a step started or finished. */
  | { type: 'plan_progress'; step: number; status: 'doing' | 'done' }
  | { type: 'compacting' }
  | { type: 'session_compacted'; before: number; after: number; trigger: 'manual' | 'auto'; durationMs?: number }
  | { type: 'session_rotated'; contextTokens: number; /** What was carried into the new session. */ summary?: string }
  /** Smart model switching picked a model for this message. */
  | { type: 'route'; label: string; reason: string; detail?: string }
  /** Codex started reviewing the changes Claude just made. */
  | { type: 'review_started' }
  | { type: 'review_result'; ok: boolean; summary: string; findings: ReviewFinding[]; fixing: boolean }
  /** A secret key was written into a project file. */
  | { type: 'secret_leak'; leaks: SecretLeak[] }

/** A browser or tool that has been paired for Remote access. */
export interface RemoteDevice {
  id: string
  name: string
  readOnly: boolean
  /** Stays paired until disconnected (otherwise it lapses after 12 hours unused). */
  remember: boolean
  createdAt: string
  lastSeen: string | null
  /** Connected right now. */
  online: boolean
}

export interface RemoteStatus {
  running: boolean
  mode: 'off' | 'local' | 'lan'
  /** Addresses to open in a browser. */
  urls: string[]
  pairingCode: string
  readOnly: boolean
  devices: RemoteDevice[]
  /** The command that adds VibeApp's tools to Claude Code (the MCP server). */
  mcpCommand: string
  /** The Tailscale address with a certificate browsers trust (local-network mode, when Tailscale provides one). */
  trustedUrl?: string
  /** Why there's no trusted address, when Tailscale is installed but can't give one. */
  trustedProblem?: string
  error?: string
}

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
/** The result of starting an installed extension to see that it works. */
export type ExtensionCheck = { ok: true; tools: number } | { ok: false; error: string }

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
  /** Upload to GitHub by itself after each request (once the project has a GitHub copy). Turned on when the copy is made or downloaded in VibeApp. */
  githubAutoBackup?: boolean
}

/** How the project on this computer compares with its copy on GitHub. */
export interface GitHubSync {
  /** The project has a GitHub copy (its "origin" is on github.com). */
  linked: boolean
  url: string | null
  branch: string
  /** Checkpoints here that GitHub doesn't have yet. */
  ahead: number
  /** Checkpoints on GitHub that aren't here (from another computer). */
  behind: number
  /** Changes here that aren't in a checkpoint yet. */
  dirty: boolean
  autoBackup: boolean
  /** The last backup went at this time (this run of VibeApp). */
  lastBackupAt?: string
  /** Why GitHub couldn't be checked or the last backup didn't go. */
  problem?: string
  /** The newer work on GitHub, newest first (its checkpoint messages). */
  incoming?: string[]
}

/** Getting the newer work from GitHub. */
export type GitHubGetResult =
  | { status: 'updated'; count: number; merged: boolean }
  | { status: 'up_to_date' }
  /** Both computers changed the same lines: nothing was changed here. */
  | { status: 'conflict'; files: string[] }

export interface GitHubRepoInfo {
  nameWithOwner: string
  description: string
  private: boolean
  updatedAt: string
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

/** One backup of VibeApp's data (a folder). */
export interface BackupInfo {
  path: string
  createdAt: string
  reason: 'nightly' | 'manual' | 'before restore' | 'export'
  bytes: number
  computer: string
  appVersion: string
}

/** One command in a project's deploy recipe, run from the project folder. */
export interface DeployStep {
  label: string
  run: string
  timeoutSec?: number
}

/** A project's one-click Deploy: written once (usually by Claude), checked by the user, then run by VibeApp. */
export interface DeployRecipe {
  name: string
  shell: 'bash' | 'powershell'
  steps: DeployStep[]
  /** Checked after the steps: the site answers (retried a few times while it restarts). */
  check?: { url: string; expectStatus?: number }
  /** Run if a step or the check fails, to put the live site back. */
  rollback?: DeployStep[]
  notes?: string
  by: 'claude' | 'user'
  /** The user has looked at the steps; only then can it run. */
  confirmed: boolean
  updatedAt: string
}

/** Progress of a running deploy, for the Deploy window. */
export type DeployEvent =
  | { type: 'started'; steps: string[]; hasCheck: boolean }
  | { type: 'step'; index: number; status: 'running' | 'ok' | 'failed' }
  | { type: 'output'; index: number; text: string }
  | { type: 'check'; status: 'running' | 'ok' | 'failed'; detail?: string }
  | { type: 'rollback'; status: 'running' | 'ok' | 'failed'; detail?: string }
  | {
      type: 'finished'
      ok: boolean
      seconds: number
      failedStep?: string
      output?: string
      checkDetail?: string
      rolledBack?: boolean
      stopped?: boolean
    }

/** What a schedule runs. */
export type ScheduleAction =
  /** A message to Claude (or Codex, as usual), in Build, Plan or Ask. */
  | { kind: 'request'; text: string; mode: 'build' | 'plan' | 'ask' }
  /** The top item of the to-do list, ticked off when it's done. */
  | { kind: 'next_todo'; mode: 'build' | 'plan' }
  /** The project's saved Deploy steps (no AI). */
  | { kind: 'deploy' }
  /** Is the site up? (no AI). Alerts when it goes down and comes back; can send Claude a request when it goes down. */
  | { kind: 'site_check'; url: string; onDown?: string }
  /** Upload the project to its GitHub copy (no AI). */
  | { kind: 'github_backup' }

/** When a schedule runs. */
export type ScheduleWhen =
  | { kind: 'once'; at: string }
  /** At a time of day (HH:MM, this computer's time) on the given weekdays (0 = Sunday); all seven = every day. */
  | { kind: 'daily'; time: string; days: number[] }
  | { kind: 'every'; minutes: number }
  /** Each time the project's Deploy succeeds. */
  | { kind: 'after_deploy' }

export interface ScheduleRun {
  at: string
  /** 'running' until it's done; 'waiting' when it needs the user (a plan, a question). */
  status: 'running' | 'ok' | 'failed' | 'skipped' | 'waiting'
  detail?: string
  trigger: 'time' | 'late' | 'manual' | 'deploy'
}

export interface Schedule {
  id: string
  projectId: string
  name: string
  action: ScheduleAction
  when: ScheduleWhen
  enabled: boolean
  /** Written by Claude: waits for the user to check it before it can run. */
  confirmed: boolean
  by: 'claude' | 'user'
  /** Requests to Claude/Codex: at most this many runs a day. */
  maxPerDay: number
  /** Requests to Claude/Codex: skipped when Claude's plan usage is at or above this percent (0 = never skip). */
  skipAboveUsage: number
  /** When it's next due (computed). */
  nextAt?: string
  runs: ScheduleRun[]
  createdAt: string
  updatedAt: string
  /** Site checks: what the last check found. */
  siteUp?: boolean
}

/** One item on a project's to-do list. */
export interface TodoItem {
  id: string
  text: string
  done: boolean
  /** Who added it: the user, or an agent noting something left for later. */
  source: 'user' | 'claude' | 'codex'
  createdAt: string
  doneAt: string | null
}

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
  /** Compact the conversation automatically once it passes rotateAtTokens. */
  autoCompact: boolean
  /** Remote access: off, this computer only (browser and API), or the local network too. */
  remoteAccess: 'off' | 'local' | 'lan'
  remotePort: number
  /** Remote screens and the API can look but not act. */
  remoteReadOnly: boolean
  /** Big requests sent in Build: ask whether to plan them first, always plan them, or just build. */
  planBigRequests: 'ask' | 'always' | 'off'
  /** null = whatever the Claude Code account/settings default to. */
  claudeModel: string | null
  /** null = whatever ~/.codex/config.toml defaults to. */
  codexModel: string | null
  /** How hard Codex thinks (low … max); null = whatever ~/.codex/config.toml defaults to. */
  codexEffort: string | null
  /** Closing the window leaves VibeApp running in the system tray. */
  trayMode: boolean
  /** Every project's schedules are paused (they don't run, and nothing is made up for afterwards). */
  schedulesPaused: boolean
  /** Start VibeApp with Windows, in the tray (installed app only). */
  startWithWindows: boolean
  /** Back up VibeApp's data once a day. */
  backupDaily: boolean
  /** Where backups go; null = Documents\VibeApp Backups. */
  backupDir: string | null
  /** How many backups are kept. */
  backupKeep: number
  backupLastAt: string | null
  backupLastError: string | null
  /** Alerts on the phone through the ntfy app. */
  phoneAlerts: boolean
  phoneAlertServer: string
  phoneAlertTopic: string | null
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
  /** Claude may hand straightforward work to Cline (when it's installed and signed in to ClinePass). */
  clineHandoffs: boolean
  /** VibeApp's background jobs (saving memory, tidy-up, brief, summaries) run on Cline instead of Haiku, when Cline is there. */
  clineHelpers: boolean
  /** Cline model for hand-offs; null = Cline's own default. */
  clineModel: string | null
  /** Cline model for background jobs; null = the hand-off model. */
  clineHelperModel: string | null
  /** Look for new versions on GitHub Releases (at start and every few hours). */
  updateChecks: boolean
  /** A version the user chose to skip: no banner for it (a newer one still shows). */
  skippedVersion: string | null
  /** The version that ran last time, to notice an update and say so once. */
  lastRunVersion: string | null
}

/** A new VibeApp version on GitHub Releases, and how far installing it has got. */
export interface UpdateState {
  status: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'
  /** The running version. */
  current: string
  /** The newest version found. */
  version?: string
  /** That version's release page ("What's new"). */
  releaseUrl?: string
  /** All releases. */
  releasesUrl: string
  /** Download progress, 0-100. */
  percent?: number
  error?: string
  checkedAt?: string
  /** False when running from source (npm run dev): there's nothing to install over. */
  canInstall: boolean
  /** Updated since last time: the version it was (for a one-time "updated" note). */
  updatedFrom?: string
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

export interface CodexModelOption extends ModelOption {
  /** The thinking efforts this model supports (e.g. low, medium, high). */
  efforts: { value: string; description: string }[]
  defaultEffort?: string
}

export interface CodexModelList {
  models: CodexModelOption[]
  /** What the user's own Codex config uses when VibeApp doesn't say. */
  defaultModel?: string
  defaultEffort?: string
}
