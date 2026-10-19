import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TalkAgent, TalkConversation } from '@shared/types'
import { getSettings } from '../settings/store'
import { claudeBlockedUntil, noteClaudeLimit } from '../usage/usage'
import { recordUsage } from '../usage/tokens'
import { askClaude, askCodex, ClaudeLimitError } from './ask'
import { addTalkMessage, historyText, loadTalk } from './talkStore'

const SYSTEM = `You are a friendly, knowledgeable assistant inside VibeApp, a desktop app for building software with AI. This is the general chat: no project is open, and you can't see or change any files. Answer questions, explain things, help think through ideas and plan, and draft text. The person may not be technical, so use plain language and short answers unless they ask for depth. If they want something built, tell them to open a project and ask there.`

const running = new Map<string, AbortController>()

/** One scratch folder per app run, so Claude/Codex have somewhere harmless to start. */
let scratch: string | undefined
function scratchDir(): string {
  scratch ??= mkdtempSync(join(tmpdir(), 'vibeapp-chat-'))
  return scratch
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function stopTalk(id: string): void {
  running.get(id)?.abort()
}

/** Adds the user's message, gets a reply from the chosen agent, and returns the updated conversation. */
export async function runTalk(id: string, text: string, agent: TalkAgent): Promise<TalkConversation> {
  if (running.has(id)) throw new Error('Still answering the last message.')
  if (agent === 'claude') {
    const until = claudeBlockedUntil()
    if (until !== null) {
      throw new Error(`Claude is out until ${clock(until)}. Switch to Codex to keep chatting.`)
    }
  }
  const withQuestion = addTalkMessage(id, { role: 'user', text })
  const abort = new AbortController()
  running.set(id, abort)
  try {
    const prompt = `Conversation so far (the last message is the one to answer now):\n\n${historyText(withQuestion)}\n\nReply to the last User message.`
    let answer
    if (agent === 'claude') {
      try {
        const chosen = getSettings().claudeModel
        answer = await askClaude({
          prompt,
          cwd: scratchDir(),
          system: SYSTEM,
          model: chosen ?? undefined,
          abort
        })
      } catch (err) {
        if (err instanceof ClaudeLimitError) {
          noteClaudeLimit(null)
          throw new Error("Claude's plan limit was reached. Switch to Codex to keep chatting.")
        }
        throw err
      }
    } else {
      answer = await askCodex({
        prompt: `${SYSTEM}\n\n${prompt}`,
        cwd: scratchDir(),
        model: getSettings().codexModel ?? undefined,
        effort: getSettings().codexEffort ?? undefined,
        abort
      })
    }
    recordUsage(undefined, 'chat', agent, answer.counts)
    return addTalkMessage(id, { role: 'assistant', text: answer.text, agent })
  } catch (err) {
    if (abort.signal.aborted) throw new Error('Stopped.')
    throw err
  } finally {
    running.delete(id)
  }
}

export function getTalk(id: string): TalkConversation | undefined {
  return loadTalk(id)
}
