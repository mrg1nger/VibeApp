import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { TalkAgent, TalkConversation, TalkSummary } from '@shared/types'

// Conversations from the standalone Chat tab: one small JSON file each, in
// the app's data folder. Not tied to any project.

function dir(): string {
  const d = join(app.getPath('userData'), 'talk')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function fileFor(id: string): string {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new Error('Invalid conversation id.')
  return join(dir(), `${id}.json`)
}

export function loadTalk(id: string): TalkConversation | undefined {
  const file = fileFor(id)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as TalkConversation
  } catch {
    return undefined
  }
}

function save(conversation: TalkConversation): void {
  writeFileSync(fileFor(conversation.id), JSON.stringify(conversation), 'utf-8')
}

export function listTalks(): TalkSummary[] {
  const out: TalkSummary[] = []
  for (const name of readdirSync(dir())) {
    if (!name.endsWith('.json')) continue
    const c = loadTalk(name.slice(0, -5))
    if (c) out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function deleteTalk(id: string): void {
  rmSync(fileFor(id), { force: true })
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine || 'New chat'
}

export function addTalkMessage(
  id: string,
  message: { role: 'user' | 'assistant'; text: string; agent?: TalkAgent }
): TalkConversation {
  const now = Date.now()
  const existing = loadTalk(id)
  const conversation: TalkConversation = existing ?? {
    id,
    title: titleFrom(message.text),
    createdAt: now,
    updatedAt: now,
    messages: []
  }
  conversation.messages.push({ ...message, at: now })
  conversation.updatedAt = now
  save(conversation)
  return conversation
}

/** The most recent messages that fit, oldest first, as plain text for the next prompt. */
export function historyText(conversation: TalkConversation, maxChars = 14_000): string {
  const lines: string[] = []
  let used = 0
  for (const m of [...conversation.messages].reverse()) {
    const who = m.role === 'user' ? 'User' : `Assistant (${m.agent === 'codex' ? 'Codex' : 'Claude'})`
    const line = `${who}: ${m.text}`
    if (used + line.length > maxChars && lines.length > 0) break
    lines.unshift(line)
    used += line.length
  }
  return lines.join('\n\n')
}
