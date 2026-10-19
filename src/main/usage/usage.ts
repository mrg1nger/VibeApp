import { spawn } from 'child_process'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { CliName, UsageSnapshot, UsageWindow } from '@shared/types'
import { resolveClaudeExecutable } from '../cli/claudeBinary'
import { killTree, resolveCodexLaunch, trackChild } from '../cli/codexExec'

const TIMEOUT_MS = 20_000
/** Repeat requests inside this window get the cached snapshot. */
const MIN_REFRESH_MS = 60_000
/** Even an explicit refresh (a click, a finished turn) waits this long between checks. */
const MIN_FORCED_REFRESH_MS = 15_000
/** After failed checks, wait 30s, 1m, 2m ... up to this long before trying again. */
const MAX_BACKOFF_MS = 10 * 60_000
/** How long the last real numbers keep showing (marked stale) through failed checks. */
const STALE_OK_MS = 6 * 60 * 60_000

const cache = new Map<CliName, UsageSnapshot>()
const lastGood = new Map<CliName, UsageSnapshot>()
const lastAttempt = new Map<CliName, number>()
const failures = new Map<CliName, number>()
const retryAt = new Map<CliName, number>()
const inFlight = new Map<CliName, Promise<UsageSnapshot>>()

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// Each Claude check starts a Claude Code process and calls Anthropic's usage
// service, so checks are spaced out, back off after failures, and a failure
// never blanks the meter while recent real numbers exist.
export function getUsage(cli: CliName, force = false): Promise<UsageSnapshot> {
  const now = Date.now()
  const cached = cache.get(cli)
  const pending = inFlight.get(cli)
  if (pending) return pending
  if (cached) {
    const sinceAttempt = now - (lastAttempt.get(cli) ?? 0)
    if (sinceAttempt < (force ? MIN_FORCED_REFRESH_MS : MIN_REFRESH_MS)) return Promise.resolve(cached)
    if (now < (retryAt.get(cli) ?? 0)) return Promise.resolve(cached)
  }
  lastAttempt.set(cli, now)
  const fetch = (cli === 'claude' ? fetchClaudeUsage() : fetchCodexUsage())
    .catch((err): UsageSnapshot => ({
      cli,
      status: 'error',
      windows: [],
      message: (err as Error).message,
      fetchedAt: Date.now()
    }))
    .then((snapshot) => {
      inFlight.delete(cli)
      if (snapshot.status !== 'error') {
        failures.delete(cli)
        retryAt.delete(cli)
        if (snapshot.status === 'ok') lastGood.set(cli, snapshot)
        cache.set(cli, snapshot)
        return snapshot
      }
      const count = (failures.get(cli) ?? 0) + 1
      failures.set(cli, count)
      retryAt.set(cli, Date.now() + Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** (count - 1)))
      const good = lastGood.get(cli)
      const shown: UsageSnapshot =
        good && Date.now() - good.fetchedAt < STALE_OK_MS
          ? {
              ...good,
              stale: true,
              message: `Couldn't refresh (${snapshot.message ?? 'unknown error'}); showing the numbers from ${clock(good.fetchedAt)}.`
            }
          : snapshot
      cache.set(cli, shown)
      return shown
    })
  inFlight.set(cli, fetch)
  return fetch
}

/** Latest known usage without waiting; kicks off a background refresh if it's stale. */
export function peekUsage(cli: CliName): UsageSnapshot | undefined {
  getUsage(cli).catch(() => undefined)
  return cache.get(cli)
}

/** Lowest share left across a snapshot's windows (0-100), or undefined if unknown. */
export function percentLeft(snapshot: UsageSnapshot | undefined): number | undefined {
  if (snapshot?.status !== 'ok' || snapshot.windows.length === 0) return undefined
  return Math.min(...snapshot.windows.map((w) => 100 - w.usedPercent))
}

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), TIMEOUT_MS))
  ])
}

/**
 * Claude plan usage via Claude Code's /usage data. The SDK marks this call
 * experimental, so any failure (including it being renamed in an SDK update)
 * just shows as "usage unavailable" rather than breaking anything.
 */
async function fetchClaudeUsage(): Promise<UsageSnapshot> {
  let release: () => void = () => {}
  const idle = new Promise<void>((resolve) => (release = resolve))
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await idle
  })()
  const q = query({ prompt, options: { pathToClaudeCodeExecutable: resolveClaudeExecutable() } })
  try {
    const usage = await withTimeout(
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      'Claude usage check'
    )
    const limits = usage.rate_limits
    if (!usage.rate_limits_available || !limits) {
      return {
        cli: 'claude',
        status: 'unavailable',
        windows: [],
        message: 'Plan limits only apply to Claude subscription logins.',
        fetchedAt: Date.now()
      }
    }
    const windows: UsageWindow[] = []
    const add = (label: string, w: { utilization: number | null; resets_at: string | null } | null | undefined): void => {
      if (w && typeof w.utilization === 'number') {
        windows.push({ label, usedPercent: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : null })
      }
    }
    add('5-hour', limits.five_hour)
    add('Weekly', limits.seven_day)
    return {
      cli: 'claude',
      status: windows.length ? 'ok' : 'unavailable',
      plan: usage.subscription_type ?? undefined,
      windows,
      fetchedAt: Date.now()
    }
  } finally {
    release()
    q.interrupt().catch(() => undefined)
  }
}

interface CodexRateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

function windowLabel(mins: number | null, fallback: string): string {
  if (mins === 300) return '5-hour'
  if (mins === 10080) return 'Weekly'
  if (!mins) return fallback
  return mins % 1440 === 0 ? `${mins / 1440}-day` : mins % 60 === 0 ? `${mins / 60}-hour` : `${mins}-min`
}

/** Codex plan usage via the app-server's account/rateLimits/read request. */
async function fetchCodexUsage(): Promise<UsageSnapshot> {
  const launch = await resolveCodexLaunch()
  const child = trackChild(spawn(launch.file, [...launch.prefixArgs, 'app-server'], { windowsHide: true, env: launch.env }))
  const send = (message: object): void => {
    child.stdin.write(JSON.stringify(message) + '\n')
  }
  try {
    const result = await withTimeout(
      new Promise<{
        rateLimits: { primary: CodexRateLimitWindow | null; secondary: CodexRateLimitWindow | null; planType: string | null }
      }>((resolve, reject) => {
        let buffer = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf-8')
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            let message: { id?: number; result?: unknown; error?: { message?: string } }
            try {
              message = JSON.parse(line)
            } catch {
              continue
            }
            if (message.id === 1) {
              if (message.error) return reject(new Error(message.error.message ?? 'Codex refused to start'))
              send({ method: 'initialized' })
              send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } })
            } else if (message.id === 2) {
              if (message.error) return reject(new Error(message.error.message ?? 'Codex usage check failed'))
              resolve(message.result as never)
            }
          }
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8')
        })
        child.on('error', reject)
        child.on('exit', (code) => reject(new Error(`Codex exited (${code}). ${stderr.slice(0, 300)}`)))
        send({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'vibeapp', title: 'VibeApp', version: '0.1.0' }, capabilities: null }
        })
      }),
      'Codex usage check'
    )
    const { primary, secondary, planType } = result.rateLimits
    const windows: UsageWindow[] = []
    for (const [w, fallback] of [
      [primary, 'Short-term'],
      [secondary, 'Long-term']
    ] as const) {
      if (w && typeof w.usedPercent === 'number') {
        windows.push({
          label: windowLabel(w.windowDurationMins, fallback),
          usedPercent: w.usedPercent,
          resetsAt: w.resetsAt ? w.resetsAt * 1000 : null
        })
      }
    }
    return {
      cli: 'codex',
      status: windows.length ? 'ok' : 'unavailable',
      plan: planType ?? undefined,
      windows,
      message: windows.length ? undefined : 'Plan limits only apply to ChatGPT logins.',
      fetchedAt: Date.now()
    }
  } finally {
    child.stdin.end()
    killTree(child)
  }
}

// ---- is Claude usable right now? -------------------------------------------------

/** Below this share of a plan window left, optional background helpers stand down. */
const HELPERS_STAND_DOWN_BELOW = 5

/** A limit seen directly (from a rejected request), until its reset time. */
let seenLimitUntil = 0

/** Remember that Claude rejected a request for its plan limit. resetsAt is epoch ms, if known. */
export function noteClaudeLimit(resetsAt: number | null): void {
  // Without a reset time, assume a short wait; the next reading corrects it.
  seenLimitUntil = resetsAt && resetsAt > Date.now() ? resetsAt : Date.now() + 15 * 60_000
}

export function clearClaudeLimit(): void {
  seenLimitUntil = 0
}

/**
 * When Claude can't run until (epoch ms), or null if it can. Based on a
 * rejection VibeApp saw itself, or on the usage reading showing a window at 100%.
 */
export function claudeBlockedUntil(): number | null {
  const now = Date.now()
  // The end-to-end test switches "Claude is out" on and off with a file, so the
  // takeover screens can be tested without using up a real plan.
  if (process.env.VIBEAPP_TEST_HOOKS === '1' && existsSync(join(app.getPath('userData'), 'test-claude-out'))) {
    return now + 60 * 60_000
  }
  let until = seenLimitUntil > now ? seenLimitUntil : 0
  const snapshot = peekUsage('claude')
  if (snapshot?.status === 'ok') {
    // Same rounding as the meter: it shows 0% left from 99.5% used.
    const exhausted = snapshot.windows.filter((w) => Math.round(w.usedPercent) >= 100 && (w.resetsAt ?? 0) > now)
    for (const w of exhausted) until = Math.max(until, w.resetsAt ?? 0)
  }
  return until > now ? until : null
}

/** Whether small optional Haiku jobs (code map, memory saving, tidy-up) may run: not when Claude is nearly out. */
export function claudeHelpersAllowed(): boolean {
  if (claudeBlockedUntil() !== null) return false
  const left = percentLeft(peekUsage('claude'))
  return left === undefined || left >= HELPERS_STAND_DOWN_BELOW
}
