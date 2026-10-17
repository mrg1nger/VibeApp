import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { ClaudeSession } from '../../src/main/orchestrator/session'
import type { VibeEvent } from '@shared/types'

/** A small game project in a temp folder, committed to git (as VibeApp projects are). */
export const GAME_FILES: Record<string, string> = {
  'shop.js': '// Shop prices: potion costs 25 gold, sword costs 140 gold.\nmodule.exports = { potion: 25, sword: 140 }\n',
  'battle.js': '// Battle damage formula: damage = attack * 2 - defence\nmodule.exports = (a, d) => a * 2 - d\n',
  'package.json': JSON.stringify({ name: 'test-game', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2)
}

export function makeProject(files: Record<string, string> = GAME_FILES): string {
  const dir = mkdtempSync(join(tmpdir(), 'vibeapp-test-project-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  git('init')
  git('add', '-A')
  git('-c', 'user.email=test@example.com', '-c', 'user.name=VibeApp test', 'commit', '-m', 'start')
  return dir
}

/** Sends a message and collects its events up to turn_complete. */
export function turn(session: ClaudeSession, text?: string, timeoutMs = 240_000): Promise<VibeEvent[]> {
  const events: VibeEvent[] = []
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off('event', on)
      reject(new Error(`No turn_complete within ${timeoutMs / 1000}s (got: ${events.map((e) => e.type).join(', ')})`))
    }, timeoutMs)
    const on = (event: VibeEvent): void => {
      events.push(event)
      if (event.type === 'turn_complete') {
        clearTimeout(timer)
        session.off('event', on)
        resolve(events)
      }
    }
    session.on('event', on)
    if (text !== undefined) session.send(text)
  })
}

export function replyText(events: VibeEvent[]): string {
  return events
    .filter((e): e is Extract<VibeEvent, { type: 'assistant_text' }> => e.type === 'assistant_text')
    .map((e) => e.text)
    .join(' ')
}

/** A unique project id per test, so tests never share memory. */
export function projectId(name: string): string {
  return `test_${name}_${Date.now().toString(36)}`
}
