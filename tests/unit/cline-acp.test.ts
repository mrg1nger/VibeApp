import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acpToolName, finishFromStop, permissionAnswer } from '../../src/main/cli/clineAcp'
import type { ClinePolicy } from '../../src/main/cline/hookPolicy'

const project = 'C:\\Users\\me\\Game'
const build: ClinePolicy = { mode: 'build', projectPath: project }

test("a hosted Cline's step is named from its ACP title", () => {
  assert.equal(acpToolName('run_commands: git status; git log'), 'run_commands')
  assert.equal(acpToolName('read_files: {"files":[{"path":"C:\\\\x"}]}'), 'read_files')
  assert.equal(acpToolName('vibe_memory__recall: {"query":"deploy"}'), 'vibe_memory__recall')
  assert.equal(acpToolName(undefined), '')
})

test('permission requests get the same answers as the hook', () => {
  // Inside the project: fine.
  assert.equal(permissionAnswer(build, 'read_files: …', { files: [{ path: `${project}\\shop.js` }] }).allow, true)
  assert.equal(permissionAnswer(build, 'editor: …', { path: `${project}\\shop.js`, old_text: '25', new_text: '30' }).allow, true)
  assert.equal(permissionAnswer(build, 'run_commands: npm test', { commands: ['npm test'] }).allow, true)
  assert.equal(permissionAnswer(build, 'vibe_memory__recall: …', { query: 'x' }).allow, true)
  // The hook's swapped echo (what arrives after the hook refused a command) goes through, so Cline hears why.
  assert.equal(permissionAnswer(build, "run_commands: echo 'BLOCKED by VibeApp: …'", { commands: ["echo 'BLOCKED by VibeApp: force-pushing with git is not allowed in this run.'"] }).allow, true)
  // A refused command that somehow arrives unswapped is still let through only as the hook's echo would be.
  assert.equal(permissionAnswer(build, 'run_commands: git push --force', { commands: ['git push --force'] }).allow, true, 'the hook swaps it; this answer mirrors the hook')
  // Things the hook would stop outright are refused here too, with a reason.
  const outside = permissionAnswer(build, 'editor: …', { path: 'C:\\Windows\\win.ini', new_text: 'x' })
  assert.equal(outside.allow, false)
  assert.match(outside.reason ?? '', /outside the project/)
  const connector = permissionAnswer(build, 'composio_search_tools: {"queries":[…]}', { queries: [] })
  assert.equal(connector.allow, false)
  assert.match(connector.reason ?? '', /composio_search_tools/)
  assert.equal(permissionAnswer({ mode: 'review', projectPath: project }, 'editor: …', { path: `${project}\\a.js` }).allow, false, 'a review may not change files')
})

test("Cline's stop reasons become VibeApp's", () => {
  assert.equal(finishFromStop('end_turn'), 'completed')
  assert.equal(finishFromStop('cancelled'), 'aborted')
  assert.equal(finishFromStop('max_turn_requests'), 'max_iterations')
  assert.equal(finishFromStop('refusal'), 'refusal')
  assert.equal(finishFromStop(undefined), 'error')
})
