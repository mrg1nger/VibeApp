import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveClaudeExecutable } from '../cli/claudeBinary'
import { countsFromSdkResult, recordUsage } from '../usage/tokens'

export interface Classification {
  size: 'quick' | 'normal' | 'complex'
  codex: 'none' | 'some' | 'most'
  reason: string
}

const SYSTEM_PROMPT = `You are a router inside a coding app. You never answer or act on requests; you only label them.
Each message contains one user request between <request> tags, sent to a coding agent (Claude) that can hand work to a second agent (Codex). Label it:
- size: "quick" = small, contained tweak (text, colour, size, spacing, a one-line change); "normal" = typical feature, fix, or any debugging question ("why does X happen?"); "complex" = several features at once, architecture changes, tricky or vague bugs, or work across many files.
- codex: "none" = not worth splitting or too small; "some" = has an independent, well-scoped part another agent could build in parallel; "most" = mostly straightforward implementation from a clear spec.
Reply with exactly one line of JSON and nothing else: {"size":"...","codex":"...","reason":"under 10 words"}`

/** A cold start is ~1.5 s; after that answers take ~0.6-0.8 s (measured). */
const TIMEOUT_MS = 5_000
/** Each request stays in the session's context; start fresh now and then. */
const MAX_REQUESTS_PER_SESSION = 40

class MessageInbox {
  private pending: SDKUserMessage[] = []
  private waiting: ((message: SDKUserMessage | null) => void) | undefined
  private closed = false

  push(text: string): void {
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
    const waiting = this.waiting
    this.waiting = undefined
    // Held until the session asks for it, if it isn't reading yet.
    if (waiting) waiting(message)
    else this.pending.push(message)
  }

  close(): void {
    this.closed = true
    this.waiting?.(null)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const message =
        this.pending.shift() ?? (await new Promise<SDKUserMessage | null>((resolve) => (this.waiting = resolve)))
      if (message) yield message
    }
  }
}

/**
 * Haiku, kept running in the background, labels each request before it's
 * sent: how big it is and how much of it suits Codex. Starting Claude Code
 * per request took ~5-10 s; a warm session answers in under a second. No
 * tools, no MCP servers, no claude.ai connectors: it only reads text.
 */
class RequestClassifier {
  private inbox: MessageInbox | undefined
  private results: AsyncIterator<unknown> | undefined
  private requests = 0
  private chain: Promise<unknown> = Promise.resolve()

  private start(): void {
    this.inbox = new MessageInbox()
    const session = query({
      prompt: this.inbox,
      options: {
        cwd: mkdtempSync(join(tmpdir(), 'vibeapp-router-')),
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        model: 'haiku',
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        settings: { disableClaudeAiConnectors: true },
        thinking: { type: 'disabled' },
        systemPrompt: SYSTEM_PROMPT
      }
    })
    this.results = session[Symbol.asyncIterator]()
    this.requests = 0
  }

  /** Starts the background session early so the first message doesn't wait for it. */
  warmUp(): void {
    try {
      if (!this.inbox) this.start()
    } catch {
      // Claude Code not ready yet (not installed, say); the first request retries.
      this.dispose()
    }
  }

  dispose(): void {
    this.inbox?.close()
    this.inbox = undefined
    this.results = undefined
  }

  /** Labels a request, or returns null (slow, failed, or unreadable) so the caller can fall back. */
  classify(
    text: string,
    context: { images?: number; pointedAt?: boolean; projectId?: string } = {}
  ): Promise<Classification | null> {
    // One session answers one request at a time.
    const run = this.chain.then(() => this.ask(text, context))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async ask(
    text: string,
    context: { images?: number; pointedAt?: boolean; projectId?: string }
  ): Promise<Classification | null> {
    if (!this.inbox || this.requests >= MAX_REQUESTS_PER_SESSION) {
      this.dispose()
      this.start()
    }
    this.requests++
    const extras = [
      context.images ? `(${context.images} image${context.images === 1 ? '' : 's'} attached)` : '',
      context.pointedAt ? '(the user pointed at one element on the page)' : ''
    ].filter(Boolean)
    // The request can't close the tag early and smuggle in instructions.
    const safe = text.slice(0, 4000).replace(/<\/?request>/gi, '')
    this.inbox!.push(`<request>\n${safe}\n</request>${extras.length ? `\n${extras.join('\n')}` : ''}`)

    const results = this.results!
    const answer = (async (): Promise<string | null> => {
      for (;;) {
        const { value, done } = await results.next()
        if (done) return null
        const message = value as { type: string; subtype?: string; result?: string }
        if (message.type === 'result') {
          recordUsage(context.projectId, 'route', 'claude', countsFromSdkResult(message as Parameters<typeof countsFromSdkResult>[0]))
          return message.subtype === 'success' ? (message.result ?? '') : null
        }
      }
    })()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), TIMEOUT_MS)))
    // A session that failed to start (or died) counts as "no answer" too.
    const reply = await Promise.race([answer.catch(() => null), timeout]).finally(() => clearTimeout(timer))
    if (reply === null) {
      // Slow or broken: this session may now be out of step, so replace it.
      this.dispose()
      return null
    }
    return parseClassification(reply)
  }
}

export function parseClassification(reply: string): Classification | null {
  const json = /\{[^{}]*\}/.exec(reply)?.[0]
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Partial<Classification>
    if (!['quick', 'normal', 'complex'].includes(parsed.size as string)) return null
    if (!['none', 'some', 'most'].includes(parsed.codex as string)) return null
    return {
      size: parsed.size as Classification['size'],
      codex: parsed.codex as Classification['codex'],
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 120) : ''
    }
  } catch {
    return null
  }
}

export const requestClassifier = new RequestClassifier()
