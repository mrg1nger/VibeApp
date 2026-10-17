// Whether a shell command stays inside the project folder, judged from the
// paths it mentions. Used to let ordinary commands (running the tests,
// starting a build) through without an Allow/Deny prompt outside Go Nutz
// mode, while anything that reaches elsewhere still asks. Deliberately
// cautious: when in doubt, it says no and the user is asked.

const HOME_REFERENCES = /(^|[\s"'=(;&|])~(?=[\\/]|$|\s)|\$HOME\b|\$env:(USERPROFILE|HOMEPATH|APPDATA|LOCALAPPDATA)\b|%(USERPROFILE|HOMEPATH|APPDATA|LOCALAPPDATA)%/i
const UNC_PATH = /\\\\[^\\\s]+\\/
const PARENT_DIR = /(^|[\s"'\\/=;&|(])\.\.([\\/]|$|[\s"';&|)])/
const WINDOWS_PATH = /[A-Za-z]:[\\/][^\s"'`;|&<>()]*/g
// Git Bash style /c/Users/... and other absolute Unix paths.
const UNIX_PATH = /(?:^|[\s"'=(;&|])(\/[^\s"'`;|&<>()]*)/g
const HARMLESS_UNIX = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function inside(path: string, project: string): boolean {
  const p = normalise(path)
  return p === project || p.startsWith(`${project}/`)
}

export function staysInProject(command: string, projectPath: string): boolean {
  if (!command.trim()) return false
  if (HOME_REFERENCES.test(command) || UNC_PATH.test(command) || PARENT_DIR.test(command)) return false
  const project = normalise(projectPath)
  for (const match of command.match(WINDOWS_PATH) ?? []) {
    if (!inside(match, project)) return false
  }
  for (const [, path] of command.matchAll(UNIX_PATH)) {
    if (HARMLESS_UNIX.has(path)) continue
    // /c/Users/me/project -> c:/users/me/project
    const drive = /^\/([a-z])(\/.*)?$/i.exec(path)
    if (drive && inside(`${drive[1]}:${drive[2] ?? ''}`, project)) continue
    return false
  }
  return true
}
