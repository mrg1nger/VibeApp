import type { FileChange } from '../git/snapshots'

// A diff too big to hand back whole becomes a digest: every changed file with
// its size of change and what it is for, plus the hunks most related to what
// was asked for, up to a budget. The agent can read anything not shown.

const HUNK_BUDGET = 4000
const HUNK_MAX_CHARS = 1100

interface Hunk {
  file: string
  index: number
  text: string
  score: number
}

const STOP = new Set([
  'this', 'that', 'with', 'from', 'have', 'will', 'should', 'file', 'files', 'code', 'make', 'when', 'then', 'there',
  'about', 'into', 'your', 'them', 'they', 'what', 'which', 'would', 'could', 'also', 'only', 'does', 'done'
])

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []).filter((w) => !STOP.has(w)))
}

interface ParsedFile {
  file: string
  hunks: string[]
  binary: boolean
}

/** Splits a unified diff into per-file lists of hunks. */
function parse(diff: string): ParsedFile[] {
  const files: ParsedFile[] = []
  for (const block of diff.split(/^(?=diff --git )/m)) {
    const named = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block)
    if (!named) continue
    const at = block.search(/^@@/m)
    const body = at === -1 ? '' : block.slice(at)
    files.push({
      file: named[2],
      hunks: body ? body.split(/^(?=@@)/m).filter(Boolean) : [],
      binary: /^Binary files |^GIT binary patch/m.test(block)
    })
  }
  return files
}

function describe(change: FileChange | undefined): string {
  if (!change) return ''
  const delta = [change.added ? `+${change.added}` : '', change.removed ? `-${change.removed}` : ''].filter(Boolean)
  return delta.length ? ` (${delta.join(' ')})` : ''
}

export function digestDiff(
  diff: string,
  changes: FileChange[],
  /** What was asked for; hunks sharing its words are shown first. */
  brief: string,
  /** One-line file descriptions from the code map. */
  summaries: Map<string, string>
): string {
  const files = parse(diff)
  if (!files.length) {
    return `(The diff is ${diff.length} characters, so it is not included; read the files you need to review.)`
  }
  const wanted = words(brief)
  const byPath = new Map(changes.map((c) => [c.path, c]))

  const hunks: Hunk[] = []
  for (const f of files) {
    // A file whose path matches the request counts for all of its hunks.
    const pathScore = [...words(f.file.replace(/[/\\._-]+/g, ' '))].filter((w) => wanted.has(w)).length
    f.hunks.forEach((text, index) => {
      const changed = text
        .split('\n')
        .filter((l) => l.startsWith('+') || l.startsWith('-'))
        .join(' ')
      const score = pathScore * 2 + [...words(changed)].filter((w) => wanted.has(w)).length
      hunks.push({ file: f.file, index, text, score })
    })
  }

  // Best-matching first; ties keep diff order, with a file's first hunk ahead of its later ones.
  const ranked = [...hunks].sort((a, b) => b.score - a.score || a.index - b.index || (a.file < b.file ? -1 : 1))
  const chosen = new Set<Hunk>()
  let used = 0
  for (const h of ranked) {
    const size = Math.min(h.text.length, HUNK_MAX_CHARS)
    if (used + size > HUNK_BUDGET) continue
    chosen.add(h)
    used += size
  }

  const lines: string[] = [`Changed files (${files.length}):`]
  for (const f of files) {
    const summary = summaries.get(f.file)
    lines.push(`- ${f.file}${describe(byPath.get(f.file))}${f.binary ? ' [binary]' : ''}${summary ? ` - ${summary}` : ''}`)
  }
  const shown: string[] = []
  for (const f of files) {
    const picked = hunks.filter((h) => h.file === f.file && chosen.has(h))
    if (!picked.length) continue
    const body = picked
      .map((h) => (h.text.length > HUNK_MAX_CHARS ? `${h.text.slice(0, HUNK_MAX_CHARS)}\n... (hunk shortened)\n` : h.text))
      .join('')
    shown.push(`--- ${f.file}\n${body.trimEnd()}`)
  }
  if (shown.length) lines.push('', 'Most relevant changes:', shown.join('\n\n'))
  const hidden = hunks.length - chosen.size
  if (hidden > 0) {
    lines.push(
      '',
      `(${hidden} more change${hidden === 1 ? '' : 's'} not shown. Read the specific files you want to check; the full diff is ${diff.length} characters.)`
    )
  }
  return lines.join('\n')
}
