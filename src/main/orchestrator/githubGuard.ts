// GitHub commands Claude is never allowed to run, even in Go Nutz mode. Once
// the user is signed in to GitHub on this computer, Claude's commands use that
// login too, and it can delete repositories, make private ones public or print
// the login itself. Those stay with the user (on github.com, or VibeApp's own
// buttons). Ordinary use (pushing, reading issues, creating a repository) is fine.

/** `gh` as a command: at the start or after a separator, optionally gh.exe or a quoted path. */
const GH = String.raw`(?:^|[;&|(\s"'\x60])(?:[^\s;&|"'\x60]*[\\/])?gh(?:\.exe)?["']?\s+`

const RULES: { pattern: RegExp; what: string }[] = [
  { pattern: new RegExp(`${GH}[\\w-]+\\s+delete\\b`, 'i'), what: 'deleting things on GitHub (repositories, releases, issues…)' },
  { pattern: new RegExp(`${GH}repo\\s+(archive|unarchive|rename)\\b`, 'i'), what: 'archiving or renaming a GitHub repository' },
  { pattern: new RegExp(`${GH}repo\\s+edit\\b[^\\n]*--(visibility|accept-visibility-change)`, 'i'), what: "changing who can see a repository" },
  { pattern: new RegExp(`${GH}auth\\s+(token|logout|refresh|switch)\\b`, 'i'), what: "reading or changing the GitHub sign-in" },
  { pattern: new RegExp(`${GH}auth\\s+status\\b[^\\n]*(--show-token|\\s-t\\b)`, 'i'), what: 'printing the GitHub sign-in' },
  { pattern: new RegExp(`${GH}api\\b[^\\n]*(-X|--method)[\\s=]*["']?DELETE\\b`, 'i'), what: 'deleting things through the GitHub API' },
  { pattern: new RegExp(`${GH}api\\b[^\\n]*(-f|-F|--field|--raw-field)\\s+["']?(private|visibility)=`, 'i'), what: "changing who can see a repository" },
  { pattern: new RegExp(`${GH}(ssh-key|gpg-key|secret|variable)\\s+(add|set|delete)\\b`, 'i'), what: "changing the GitHub account's keys or secrets" },
  { pattern: /\bgit(?:\.exe)?["']?\s+credential(?:-manager)?\b/i, what: 'reading saved git passwords' },
  { pattern: /\bgit(?:\.exe)?["']?\s+push\b[^\n]*(--mirror|--delete|\s-d\b|\s:[\w./-]+)/i, what: 'deleting branches on GitHub' }
]

/** What a command would do that Claude isn't allowed to (in plain words), or null if it's fine. */
export function githubDanger(command: string): string | null {
  if (!command) return null
  for (const rule of RULES) if (rule.pattern.test(command)) return rule.what
  return null
}

export function githubDenyReason(what: string): string {
  return `VibeApp doesn't let Claude do this: ${what}. It's the user's own GitHub account, so this stays with them. Don't try another way round it. If it's really needed, explain in plain words what you wanted to do and why, and they can do it on github.com themselves.`
}
