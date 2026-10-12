import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { detectSecrets } from '@shared/secretPatterns'
import { getSettings } from '../settings/store'
import { memoryDb } from './paths'
import { listFacts } from './store'

const BEGIN = '<!-- vibeapp:begin (managed by VibeApp; edits inside this block are overwritten) -->'
const END = '<!-- vibeapp:end -->'
const FILE = 'AGENTS.md'

/**
 * Keeps a block of the project's key facts in AGENTS.md, so other agents
 * opened in the folder (Codex reads this file on its own; others can be
 * pointed at it) share the context. Off by default. Only this project's own
 * facts go in (never the user's global preferences), and anything that looks
 * like a secret is left out.
 */
export function syncAgentsFile(projectId: string, projectPath: string): void {
  try {
    if (!getSettings().exportAgentsFile) return
    const facts = listFacts(memoryDb(), projectId).filter((f) => f.key && detectSecrets(f.text).length === 0)
    const lines = facts.length ? facts.map((f) => `- ${f.text}`).join('\n') : '- (nothing recorded yet)'
    const block = `${BEGIN}\n## Project notes\n${lines}\n${END}`
    const file = join(projectPath, FILE)

    if (!existsSync(file)) {
      writeFileSync(file, `# Agent notes\n\n${block}\n`, 'utf-8')
      // A file VibeApp created stays out of git (and so out of a published repo)
      // unless the user decides otherwise.
      const ignore = join(projectPath, '.gitignore')
      const current = existsSync(ignore) ? readFileSync(ignore, 'utf-8') : ''
      if (!current.split(/\r?\n/).some((l) => l.trim() === FILE)) {
        appendFileSync(ignore, `${current && !current.endsWith('\n') ? '\n' : ''}${FILE}\n`, 'utf-8')
      }
      return
    }

    const text = readFileSync(file, 'utf-8')
    const start = text.indexOf('<!-- vibeapp:begin')
    const end = text.indexOf(END)
    const next =
      start !== -1 && end > start
        ? `${text.slice(0, start)}${block}${text.slice(end + END.length)}`
        : `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}\n`
    if (next !== text) writeFileSync(file, next, 'utf-8')
  } catch (err) {
    console.warn('Updating AGENTS.md failed:', (err as Error).message)
  }
}
