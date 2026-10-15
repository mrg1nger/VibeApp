import { scrubSecrets } from '../cli/codexActivity'
import { loadTranscript } from '../projects/transcript'

// Commands that were actually run are where "how we deploy / test / restart
// it" lives, and they're invisible to a summary written from chat text. This
// picks out the ones that look like a procedure rather than looking around.

const NOTABLE =
  /\b(ssh|scp|sftp|rsync|git\s+(push|archive|tag|pull|clone)|docker|docker-compose|systemctl|service|pm2|nginx|caddy|deploy|release|publish|npm\s+(run|publish|test|ci|install)|npx|pnpm|yarn|node|python|pytest|curl|wget|tar|zip|unzip|kubectl|terraform|vercel|netlify|fly|heroku|pg_dump|pg_restore|mysqldump|backup|restore|migrate|make|cargo|go\s+(build|run|test)|dotnet)\b/i

const TRIVIAL = /^(cd|ls|dir|pwd|cat|echo|type|head|tail|git\s+(status|diff|log|add|commit|show|branch)|grep|rg|find|sleep|clear|which|where)\b/i

const MAX_COMMAND_CHARS = 600

/** True for a command worth showing a note-taker: it does something, not just looks around. */
export function isNotableCommand(command: string): boolean {
  const first = command.trim()
  if (!first || first.length < 8) return false
  // "cd project && git archive ..." is about git archive, not cd.
  const parts = first.split(/&&|\|\||;|\n/).map((p) => p.trim()).filter(Boolean)
  return parts.some((p) => !TRIVIAL.test(p) && NOTABLE.test(p))
}

/** A command as it should be shown to a model: secrets scrubbed, long ones clipped. */
export function cleanCommand(command: string): string {
  const scrubbed = scrubSecrets(command.replace(/\s+/g, ' ').trim())
  return scrubbed.length > MAX_COMMAND_CHARS ? `${scrubbed.slice(0, MAX_COMMAND_CHARS)} ...` : scrubbed
}

/** The most recent notable commands from the project's saved chat (oldest first, no repeats). */
export function recentNotableCommands(projectId: string, limit = 25): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  try {
    const entries = loadTranscript(projectId)
    for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
      const event = entries[i].event
      if (!event) continue
      let command: string | undefined
      if (event.type === 'tool_call' && (event.name === 'Bash' || event.name === 'PowerShell')) {
        command = (event.input as { command?: string } | undefined)?.command
      } else if (event.type === 'delegation_activity' && event.activity.step === 'run' && event.activity.done) {
        // Only commands that worked say how something is done.
        if (event.activity.ok === false) continue
        command = event.activity.full ?? event.activity.text
      }
      if (!command || !isNotableCommand(command)) continue
      const clean = cleanCommand(command)
      if (seen.has(clean)) continue
      seen.add(clean)
      out.unshift(clean)
    }
  } catch {
    // No transcript yet: nothing to show.
  }
  return out
}
