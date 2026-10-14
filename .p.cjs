const fs = require('fs')
const f = 'src/main/orchestrator/takeover.ts'
const raw = fs.readFileSync(f, 'utf8'); const crlf = raw.includes('\r\n'); let s = raw.replace(/\r\n/g, '\n')
function rep(a, b) { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 50)); s = s.replace(a, b) }
rep("import { finishHandoff, keyFactsBlock, startHandoff } from '../memory/store'",
    "import { finishHandoff, getMeta, keyFactsBlock, setMeta, startHandoff } from '../memory/store'")
rep("/** Per project: what Codex handled while Claude was out, for Claude's catch-up note. */\nconst handled = new Map<string, { request: string; outcome: string }[]>()\n",
`/** What Codex handled directly while Claude was out, kept (across restarts) for Claude's catch-up note. */
interface CatchUpItem {
  request: string
  outcome: string
  files: string[]
  /** The project as it was before this request, for \`git diff <snapshot>\`. */
  snapshot?: string
}

const catchUpKey = (projectId: string): string => \`catchup:\${projectId}\`

function readCatchUp(projectId: string): CatchUpItem[] {
  try {
    const raw = getMeta(memoryDb(), catchUpKey(projectId))
    return raw ? (JSON.parse(raw) as CatchUpItem[]) : []
  } catch {
    return []
  }
}

function writeCatchUp(projectId: string, items: CatchUpItem[]): void {
  attempt(() => {
    if (items.length) setMeta(memoryDb(), catchUpKey(projectId), JSON.stringify(items.slice(-8)))
    else memoryDb().prepare('DELETE FROM meta WHERE key = ?').run(catchUpKey(projectId))
  })
}
`)
rep("  resetsAt: number | null\n  unsandboxed: boolean\n  emit:", "  resetsAt: number | null\n  /** The project as it was before this request (the Undo snapshot). */\n  snapshot?: string\n  unsandboxed: boolean\n  emit:")
const start = s.indexOf("/** A note for Claude's next message")
const end = s.indexOf("/** Runs one request on Codex")
s = s.slice(0, start) + `/** A note for Claude's next message, listing what Codex did while it was out. Clears the list. */
export function takeCatchUpNote(projectId: string): string | undefined {
  const items = readCatchUp(projectId)
  if (!items.length) return undefined
  writeCatchUp(projectId, [])
  const many = items.length > 1
  const lines = items.map((i, n) => {
    const files = i.files.length
      ? \` Files: \${i.files.slice(0, 12).join(', ')}\${i.files.length > 12 ? \` and \${i.files.length - 12} more\` : ''}.\`
      : ''
    return \`\${n + 1}. "\${i.request.slice(0, 200)}" -> \${i.outcome.slice(0, 300)}\${files}\`
  })
  const first = items.find((i) => i.snapshot)?.snapshot
  return [
    \`[VibeApp note: while Claude's plan limit was reached, Codex handled \${many ? 'these requests' : 'this request'} directly, so \${many ? 'they are' : 'it is'} not in this conversation.\`,
    "Those changes are in the working tree as uncommitted edits (VibeApp doesn't commit for the user), so \`git status\` and \`git diff\` will show them mixed in with everything else. That is expected and is not part of the new request unless the user says so; don't try to untangle or revert them.",
    first ? \`To see exactly what Codex changed in that time: \\`git diff \${first}\\` (plus \\`git status --short\\` for new files).\` : '',
    'Judge what changed during a request from the hand-off results (they list their own files and diff), not from a whole-tree git diff. The handoffs tool has the full reports.',
    'What Codex did:',
    ...lines
  ]
    .filter(Boolean)
    .join('\n') + ']'
}

export function forgetTakeover(projectId: string): void {
  threads.delete(projectId)
  writeCatchUp(projectId, [])
}

` + s.slice(end)
rep("    const list = handled.get(projectId) ?? []\n    list.push({\n      request: req.text,\n      outcome: `${status}${changes?.length ? `, changed ${changes.length} file(s)` : ''}. ${report}`\n    })\n    handled.set(projectId, list.slice(-5))\n",
"    writeCatchUp(projectId, [\n      ...readCatchUp(projectId),\n      {\n        request: req.text,\n        outcome: `${status}. ${report}`,\n        files: changes?.map((c) => c.path) ?? [],\n        snapshot: req.snapshot\n      }\n    ])\n")
fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s)

const h = 'src/main/ipc/handlers.ts'
let r2 = fs.readFileSync(h, 'utf8'); const c2 = r2.includes('\r\n'); r2 = r2.replace(/\r\n/g, '\n')
const a = "    resetsAt,\n    unsandboxed: session.isGoNutzMode(),"
if (!r2.includes(a)) throw new Error('handlers missing')
r2 = r2.replace(a, "    resetsAt,\n    snapshot: request.snapshot,\n    unsandboxed: session.isGoNutzMode(),")
fs.writeFileSync(h, c2 ? r2.replace(/\n/g, '\r\n') : r2)

const st = 'src/main/memory/store.ts'
let r3 = fs.readFileSync(st, 'utf8'); const c3 = r3.includes('\r\n'); r3 = r3.replace(/\r\n/g, '\n')
const b = "db.prepare('DELETE FROM meta WHERE key IN (?, ?)').run(`history_imported:${projectId}`, `tidy:${projectId}`)"
if (!r3.includes(b)) throw new Error('store missing')
r3 = r3.replace(b, "db.prepare('DELETE FROM meta WHERE key IN (?, ?, ?)').run(\n      `history_imported:${projectId}`,\n      `tidy:${projectId}`,\n      `catchup:${projectId}`\n    )")
fs.writeFileSync(st, c3 ? r3.replace(/\n/g, '\r\n') : r3)
