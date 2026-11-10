import { homedir } from 'os'
import { resolve, sep } from 'path'

// Plan mode is "look around, change nothing". Claude Code's own plan mode doesn't
// enforce that: tested with the SDK VibeApp ships (2026-11-10), a Bash command that
// writes a file ran in plan mode whether the session started in plan, acceptEdits or
// (switched from) bypassPermissions. And VibeApp approves its own tools in every mode.
// So VibeApp decides here, before every tool call, what planning may do. Anything
// else is turned away with a note pointing Claude at leave_plan_mode, which asks the
// user once.

/** Where Claude Code keeps a conversation's plan (written in plan mode, so always allowed). */
export function isPlanFile(file: string): boolean {
  const dir = resolve(homedir(), '.claude', 'plans')
  const full = resolve(file)
  return full.toLowerCase().startsWith(`${dir.toLowerCase()}${sep}`) && full.toLowerCase().endsWith('.md')
}

/** Claude Code tools that only look, ask, or organise the conversation. */
const LOOKING_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'ToolSearch',
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
  'BashOutput',
  'KillShell',
  'KillBash',
  // Helpers and skills: their own tool calls come through this check too.
  'Agent',
  'Task',
  'Skill'
])

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** VibeApp's own tools that act rather than look. Drafts (save_deploy_recipe, save_schedule) still need the user's check, so they're fine. */
const ACTING_VIBE_TOOLS: Record<string, string> = {
  run_deploy: 'run the Deploy',
  run_codex_subtask: 'hand work to Codex',
  run_cline_subtask: 'hand work to Cline',
  install_extension: 'install a tool'
}

/** Names of other tool servers' tools that only look (Playwright's snapshot and navigate, Context7's docs...). */
const LOOKING_TOOL_NAME =
  /^(get|list|read|search|find|fetch|query|resolve|lookup|look|view|show|describe|status|check|inspect|sequentialthinking|think)|(^|_)(snapshot|screenshot|take_screenshot|navigate|navigate_back|tabs|console_messages|network_requests|wait_for|docs|resolve-library-id|get-library-docs)$/i

/**
 * Whether a tool call is allowed while planning. Returns a short description of
 * what it would do when it isn't ("run a command: ssh …"), or undefined when it's fine.
 */
export function planModeBlock(toolName: string, input: unknown): string | undefined {
  if (LOOKING_TOOLS.has(toolName)) return undefined
  if (EDIT_TOOLS.has(toolName)) {
    const file = String((input as { file_path?: string; notebook_path?: string })?.file_path ?? (input as { notebook_path?: string })?.notebook_path ?? '')
    if (file && isPlanFile(file)) return undefined
    return `change ${file ? shortPath(file) : 'a file'}`
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = String((input as { command?: string })?.command ?? '')
    return isReadOnlyCommand(command, toolName === 'PowerShell' ? 'powershell' : 'bash')
      ? undefined
      : `run a command: ${oneLine(command)}`
  }
  if (toolName.startsWith('mcp__')) {
    const [, server, name = ''] = toolName.split('__')
    if (server === 'vibe_memory') return undefined // memory, notes and to-dos, as in Ask mode
    if (server === 'vibe_tools') return ACTING_VIBE_TOOLS[name]
    return LOOKING_TOOL_NAME.test(name) ? undefined : `use ${server}: ${name}`
  }
  return `use ${toolName}`
}

const oneLine = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat
}

const shortPath = (p: string): string => p.split(/[\\/]/).slice(-2).join('/')

// ---- Shell commands -------------------------------------------------------

/** Commands that only read or report (checked further below where they have writing options). */
const READ_ONLY_PROGRAMS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'tree',
  'pwd', 'echo', 'printf', 'which', 'where', 'whereis', 'file', 'stat', 'du', 'df', 'date', 'whoami', 'hostname',
  'uname', 'env', 'printenv', 'sort', 'uniq', 'cut', 'tr', 'sed', 'jq', 'diff', 'cmp', 'basename', 'dirname',
  'realpath', 'readlink', 'test', '[', 'true', 'false', 'column', 'nl', 'od', 'hexdump', 'xxd', 'md5sum',
  'sha1sum', 'sha256sum', 'ps', 'tasklist', 'netstat', 'ping', 'nslookup', 'dig', 'cd', 'pushd', 'popd',
  'curl', 'git', 'node', 'npm', 'pnpm', 'yarn', 'python', 'python3', 'py', 'tsc', 'code', 'systeminfo', 'ver',
  // PowerShell's reading cmdlets (and their usual aliases)
  'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'get-item', 'gi', 'get-itemproperty',
  'gp', 'test-path', 'resolve-path', 'rvpa', 'get-location', 'gl', 'set-location', 'sl', 'push-location',
  'pop-location', 'get-command', 'gcm', 'get-process', 'gps', 'get-service', 'gsv', 'measure-object', 'measure',
  'select-object', 'select', 'where-object', 'where', '?', 'foreach-object', 'foreach', '%', 'sort-object',
  'group-object', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'out-null', 'write-output',
  'write-host', 'get-date', 'get-filehash', 'get-netipaddress', 'get-nettcpconnection', 'test-netconnection',
  'convertfrom-json', 'convertto-json', 'get-help', 'get-member', 'gm', 'get-psdrive', 'get-acl', 'get-variable', 'gv'
])

/** Git subcommands that only read. */
const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog',
  'cat-file', 'grep', 'whatchanged', 'rev-list', 'name-rev', 'merge-base', 'count-objects', 'help', 'version'
])

/** Anywhere in a PowerShell command (script blocks included): cmdlets and aliases that change things or run other code. */
const PS_ACTING =
  /\b(set|new|remove|move|copy|rename|clear|add|export|start|stop|restart|invoke|install|uninstall|update|write|register|unregister|enable|disable|import|mount|dismount|send|suspend|resume|expand|compress|grant|revoke|protect|unprotect|reset|restore|save|out|tee)-(?!output\b|host\b|string\b|null\b|location\b)\w+/i
const ACTING_WORDS =
  /(^|[\s{;|(&])(rm|del|erase|rd|rmdir|mv|move|cp|copy|ren|ri|mi|cpi|ni|md|mkdir|sc|ac|iex|saps|start|kill|spps|tee|touch|chmod|chown|ln|dd|truncate|shred|sudo|ssh|scp|rsync|xargs)(?=$|[\s;}|)&])/i
const DOTNET_ACTING = /::\s*(write|delete|move|copy|create|append|replace)|\.(delete|moveto|copyto|create|writealltext|appendalltext)\s*\(/i

/**
 * True when every part of a shell command only reads. Conservative: anything it
 * doesn't recognise counts as changing something (Claude can put it in the plan
 * instead, or ask to leave Plan mode).
 */
export function isReadOnlyCommand(command: string, shell: 'bash' | 'powershell'): boolean {
  if (!command.trim()) return true
  if (shell === 'powershell' && (PS_ACTING.test(command) || DOTNET_ACTING.test(command))) return false
  const parts = splitCommand(command, shell)
  if (!parts) return false
  for (const part of parts) {
    if (shell === 'powershell' && ACTING_WORDS.test(part)) return false
    if (!readOnlyPart(part)) return false
  }
  return true
}

/**
 * Splits at unquoted ;, &&, ||, | and newlines. Returns null when the command
 * writes through a redirect or runs a substitution (`...`, $(...)) outside single quotes.
 */
function splitCommand(command: string, shell: 'bash' | 'powershell'): string[] | null {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const next = command[i + 1]
    if (quote) {
      if (c === quote) quote = null
      else if (quote === '"' && (c === '$' && next === '(')) return null
      else if (quote === '"' && c === '`' && shell === 'bash') return null
      current += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current += c
      continue
    }
    if (c === '$' && next === '(') return null
    if (c === '`' && shell === 'bash') return null
    if (c === '\\' && shell === 'bash' && next !== undefined) {
      current += c + next
      i++
      continue
    }
    if (c === '>') {
      // Only throwing output away (or merging streams) is fine.
      const rest = command.slice(i + 1).replace(/^>/, '').trimStart()
      const target = /^(&[12]|\/dev\/null|\$null|nul)(?=$|[\s;|&)])/i.exec(rest)
      if (!target) return null
      const skip = command.slice(i + 1).length - rest.length + target[0].length
      current += command.slice(i, i + 1 + skip)
      i += skip
      continue
    }
    if (c === ';' || c === '\n' || c === '\r' || c === '|' || c === '&') {
      if ((c === '|' || c === '&') && next === c) i++
      else if (c === '&' && shell === 'bash') return null // running something in the background
      parts.push(current)
      current = ''
      continue
    }
    current += c
  }
  if (quote) return null
  parts.push(current)
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** Words of one simple command, quotes removed. */
function words(part: string): string[] {
  return (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''))
}

function readOnlyPart(part: string): boolean {
  // PowerShell: `$files = Get-ChildItem` is checked by what's assigned; `$files.Count` only reads.
  const assigned = /^\$[\w:]+\s*=\s*(.*)$/s.exec(part)
  if (assigned) return assigned[1].trim() === '' || readOnlyPart(assigned[1].trim())
  if (/^\$[\w:]+(\.\w+)*(\[\d+\])?$/.test(part)) return true
  let w = words(part)
  // Leading VAR=value assignments (bash) and a 2>&1-style stream number aren't the program.
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1)
  if (!w.length) return true
  const program = w[0].replace(/\.exe$/i, '').replace(/^.*[\\/]/, '').toLowerCase()
  if (!READ_ONLY_PROGRAMS.has(program)) return false
  const args = w.slice(1)
  const has = (re: RegExp): boolean => args.some((a) => re.test(a))
  switch (program) {
    case 'find':
      return !has(/^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/)
    case 'sed':
      return !has(/^(-i|--in-place)/) && !has(/^-[a-z]*i/)
    case 'sort':
      return !has(/^(-o|--output)/)
    case 'env':
    case 'printenv':
      return args.length === 0 || (program === 'printenv' && args.every((a) => !a.startsWith('-')))
    case 'curl':
      return curlReadOnly(args)
    case 'git':
      return gitReadOnly(args)
    case 'node':
    case 'python':
    case 'python3':
    case 'py':
      return args.length === 1 && /^(-v|--version|-V)$/.test(args[0])
    case 'tsc':
      return args.length === 1 && /^(-v|--version)$/.test(args[0])
    case 'code':
      return args.length === 1 && /^(-v|--version)$/.test(args[0])
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return args.length > 0 && /^(ls|list|view|info|outdated|-v|--version|why|explain|config)$/.test(args[0]) && (args[0] !== 'config' || /^(get|list|ls)$/.test(args[1] ?? ''))
    default:
      return true
  }
}

function curlReadOnly(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (/^(-d|--data.*|-F|--form.*|-T|--upload-file|-o|-O|--output.*|--remote-name.*|-K|--config|--json|-c|--cookie-jar)$/.test(a)) return false
    if (/^-[a-zA-Z]*[dFTOoKc]/.test(a) && !a.startsWith('--')) return false // combined short flags such as -sO
    if (/^(-X|--request)$/.test(a)) {
      if (!/^(GET|HEAD|OPTIONS)$/i.test(args[i + 1] ?? '')) return false
      i++
    } else if (/^-X(?!GET$|HEAD$)/i.test(a)) return false
  }
  return true
}

function gitReadOnly(args: string[]): boolean {
  let i = 0
  // git -C <dir> / --no-pager / -c key=value (a -c can run programs: refuse it)
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') i += 2
    else if (args[i] === '--no-pager' || args[i] === '-P') i++
    else return false
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (!sub) return true
  if (rest.some((a) => /^--output/.test(a))) return false
  if (GIT_READ.has(sub)) return true
  switch (sub) {
    case 'branch':
      return rest.every((a) => /^(-a|--all|-r|--remotes|-v|-vv|--verbose|--list|-l|--show-current|--contains|--merged|--no-merged)$/.test(a) || !a.startsWith('-')) && (rest.length === 0 || rest.some((a) => a.startsWith('-')))
    case 'remote':
      return rest.length === 0 || /^(-v|--verbose|show|get-url)$/.test(rest[0])
    case 'tag':
      return rest.length === 0 || /^(-l|--list|--contains|--points-at)$/.test(rest[0])
    case 'stash':
      return /^(list|show)$/.test(rest[0] ?? '')
    case 'worktree':
      return rest[0] === 'list'
    case 'config':
      return /^(--get|--get-all|--list|-l|--get-regexp)$/.test(rest[0] ?? '')
    case 'reflog':
      return rest.length === 0 || rest[0] === 'show'
    default:
      return false
  }
}
