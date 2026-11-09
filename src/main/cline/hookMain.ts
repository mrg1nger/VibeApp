// Cline's PreToolUse hook for VibeApp runs (bundled on its own to
// out/main/cline/clineHook.cjs and copied to <VibeApp's Cline folder>/hooks/
// PreToolUse.js). Cline runs it with Node for every tool call, passing the
// call as JSON on stdin; the run's rules come in VIBEAPP_CLINE_POLICY.
//
// Cline carries on as if there were no hook when one fails or answers with
// something it can't read, so every failure here refuses the call instead.

import { appendFileSync } from 'fs'
import { decideToolCall, hookOutput, type ClinePolicy } from './hookPolicy'

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (raw += chunk))
process.stdin.on('end', () => {
  let out: Record<string, unknown>
  let name = ''
  try {
    const policy = JSON.parse(process.env.VIBEAPP_CLINE_POLICY ?? '') as ClinePolicy
    const payload = JSON.parse(raw) as { hookName?: string; tool_call?: { name?: string; input?: unknown } }
    // Only tool calls are decided; other events (if any arrive) pass.
    if (payload.hookName && payload.hookName !== 'tool_call') {
      out = {}
    } else {
      name = payload.tool_call?.name ?? ''
      const decision = decideToolCall(policy, payload.tool_call ?? {})
      out = hookOutput(decision)
      if (!decision.allow && process.env.VIBEAPP_CLINE_HOOK_LOG) {
        appendFileSync(process.env.VIBEAPP_CLINE_HOOK_LOG, `${JSON.stringify({ at: new Date().toISOString(), tool: name, reason: decision.reason })}\n`)
      }
    }
  } catch (err) {
    out = { cancel: true, errorMessage: `VibeApp's safety check failed (${(err as Error).message}), so the ${name || 'tool'} call was stopped.` }
  }
  process.stdout.write(JSON.stringify(out))
})
