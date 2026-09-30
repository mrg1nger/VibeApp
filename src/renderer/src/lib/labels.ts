function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Shortens paths inside the project to project-relative ones:
 * "Edited C:\Users\me\Vibe\MrgRPG\src\player.js" -> "Edited src/player.js".
 * Matches either slash style and any letter case, as Windows paths can mix both.
 */
export function shortenProjectPaths(label: string, projectPath: string): string {
  const parts = projectPath.split(/[\\/]+/).filter(Boolean).map(escapeRegExp)
  if (parts.length === 0) return label
  const root = parts.join('[\\\\/]+')
  const inside = new RegExp(`${root}[\\\\/]+([^\\s"'\`]*)`, 'gi')
  // The project folder itself (e.g. "in the project root (C:\...\MrgRPG)") becomes its name.
  const folder = new RegExp(`${root}(?![\\w.-])`, 'gi')
  const name = projectPath.split(/[\\/]+/).filter(Boolean).pop() ?? ''
  return label.replace(inside, (_match, rest: string) => rest.replace(/\\/g, '/')).replace(folder, name)
}
