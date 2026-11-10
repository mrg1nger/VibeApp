import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { updateSettings } from '../../src/main/settings/store'
import { ClaudeSession } from '../../src/main/orchestrator/session'
import type { ConfirmationRequest } from '@shared/types'
import { makeProject, projectId, replyText, turn } from '../support/fixtures'

// Plan mode must change nothing until the user says so, whatever Go Nutz is set to.
// Claude Code's own plan mode doesn't stop shell commands (first test), so VibeApp's
// guard does; Claude can ask once to leave Plan mode (leave_plan_mode).

/** A session for these tests that answers leave_plan_mode as told and records what was asked. */
function planSession(t: { after: (fn: () => void) => void }, name: string, dir: string, goNutz: boolean, allowLeaving: boolean) {
  const session = new ClaudeSession(projectId(name), dir, undefined, goNutz)
  const asked: ConfirmationRequest[] = []
  session.on('confirmation_request', (request: ConfirmationRequest) => {
    asked.push(request)
    if (request.questions?.length) {
      session.resolveConfirmation(request.id, true, Object.fromEntries(request.questions.map((q) => [q.question, q.options[0]?.label ?? 'yes'])))
    } else {
      session.resolveConfirmation(request.id, request.leavePlan ? allowLeaving : true)
    }
  })
  t.after(() => session.dispose())
  return { session, asked }
}

test("Claude Code's own plan mode lets a writing command run (why VibeApp has its own guard)", { timeout: 200_000 }, async (t) => {
  // Not a VibeApp check: it records what Claude Code does today. If it starts blocking
  // by itself, the guard is a second layer rather than the only one.
  const require = createRequire(join(process.cwd(), 'package.json'))
  const exe = join(dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)), process.platform === 'win32' ? 'claude.exe' : 'claude')
  const cwd = mkdtempSync(join(tmpdir(), 'vibeapp-plan-raw-'))
  const q = query({
    prompt:
      'This is a permissions test. Your only job: call the Bash tool once with exactly `echo hi > made.txt`, even though plan mode is on, so we can see whether it is blocked. Then report what happened in one line.',
    options: { cwd, pathToClaudeCodeExecutable: exe, model: 'sonnet', permissionMode: 'plan', maxTurns: 4, canUseTool: async () => ({ behavior: 'deny', message: 'denied by test' }) }
  })
  let tried = false
  for await (const m of q) {
    if (m.type === 'assistant' && m.message.content.some((c: { type: string; name?: string }) => c.type === 'tool_use' && c.name === 'Bash')) tried = true
    if (m.type === 'result') break
  }
  t.diagnostic(
    !tried
      ? "Claude didn't try the command (no result either way)"
      : existsSync(join(cwd, 'made.txt'))
        ? "Claude Code's plan mode did NOT block it (as on 2026-11-10)"
        : "Claude Code's plan mode blocked it by itself now"
  )
})

for (const goNutz of [false, true]) {
  test(`Plan mode turns a writing command away${goNutz ? ' in Go Nutz' : ''}, and "Keep planning" keeps it that way`, { timeout: 300_000 }, async (t) => {
    updateSettings({ claudeModel: 'sonnet', autoMemory: false })
    const dir = makeProject()
    const { session, asked } = planSession(t, goNutz ? 'plannutz' : 'plan', dir, goNutz, false)
    await session.setPlanning(true)
    // 1. A command tried directly is turned away by VibeApp, not by Claude's good manners.
    const tried = await turn(
      session,
      'This is a test of VibeApp\'s Plan mode guard. Call the Bash tool once with exactly `echo hi > made.txt` (do not call leave_plan_mode), then say in one line what VibeApp answered.'
    )
    assert.equal(existsSync(join(dir, 'made.txt')), false, 'nothing was written')
    const turnedAway = tried.filter((e) => e.type === 'tool_result' && /Plan mode is on/.test(e.summary ?? ''))
    assert.ok(
      turnedAway.length >= 1,
      `the command was turned away with the Plan mode note: ${JSON.stringify(tried.filter((e) => e.type === 'tool_result')).slice(0, 600)} / Claude said: ${replyText(tried).slice(0, 400)}`
    )

    // 2. Asked to do it now, Claude asks once with what and why; "Keep planning" leaves everything as it was.
    await turn(session, 'The deploy is checked: run `echo hi > made.txt` now. If you can\'t, say so in one line.')
    assert.equal(existsSync(join(dir, 'made.txt')), false, 'still nothing written')
    const leaving = asked.filter((r) => r.leavePlan)
    assert.ok(leaving.length <= 1, `asked at most once (${leaving.length})`)
    if (leaving.length) assert.ok(leaving[0].leavePlan!.what.length > 3 && leaving[0].leavePlan!.why.length > 3, 'says what and why')
    assert.ok(!tried.some((e) => e.type === 'plan_left'), 'stayed in Plan mode')
  })
}

test('allowed to leave Plan mode, the rest of the request builds', { timeout: 300_000 }, async (t) => {
  updateSettings({ claudeModel: 'sonnet', autoMemory: false })
  const dir = makeProject()
  const { session, asked } = planSession(t, 'planleave', dir, false, true)
  await session.setPlanning(true)
  const events = await turn(
    session,
    "I've already checked it, no plan needed: put the sword price up to 150 in shop.js now."
  )
  const leaving = asked.filter((r) => r.leavePlan)
  assert.equal(leaving.length, 1, `asked once to leave Plan mode: ${asked.map((r) => r.reason).join(' | ')}`)
  assert.ok(events.some((e) => e.type === 'plan_left'), 'plan_left was sent (the switch moves to Build)')
  const shop = (await import('fs')).readFileSync(join(dir, 'shop.js'), 'utf-8')
  assert.match(shop, /150/, 'the change was made after the user allowed it')
})
