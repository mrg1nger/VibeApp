import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { mkdirSync, copyFileSync, writeFileSync, existsSync } from 'fs'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { runScribe } from '../../src/main/memory/scribe'
import { refreshBrief } from '../../src/main/memory/brief'
import { memoryDb } from '../../src/main/memory/paths'
import { listFacts, rememberFact } from '../../src/main/memory/store'
import { cleanCommand } from '../../src/main/memory/commands'
import { installExtensionForAgent } from '../../src/main/extensions/install'
import { activeExtensions, listExtensions, removeExtension } from '../../src/main/extensions/store'
import { runTakeover } from '../../src/main/orchestrator/takeover'
import { resolveClaudeExecutable } from '../../src/main/cli/claudeBinary'
import type { VibeEvent } from '@shared/types'
import { makeProject, projectId } from '../support/fixtures'

const ECHO_SERVER = join(__dirname, '..', '..', 'tests', 'support', 'echo-mcp.js')

test('a deploy that worked is saved as a procedure, and the brief describes it without secrets', { timeout: 300_000 }, async () => {
  const pid = projectId('procedure')
  const commands = [
    'cd "yay" && git archive --format=tar.gz --output=/tmp/deploy.tar.gz master && scp -i ~/.ssh/game /tmp/deploy.tar.gz root@$GAME_IP:/tmp/deploy.tar.gz',
    'ssh -i ~/.ssh/game root@$GAME_IP "cd /opt/game && tar xzf /tmp/deploy.tar.gz && systemctl restart game.service && systemctl is-active game.service"',
    'curl -sk "https://game.example.com/" -o /dev/null -w "live: %{http_code}"'
  ].map(cleanCommand)
  await runScribe(pid, {
    request: 'yes deploy now',
    replies: ['Deployed and live at game.example.com. game.service restarted and is active; the site answered 200.'],
    actions: [],
    commands,
    stopped: false,
    hadError: false
  })
  const procedure = listFacts(memoryDb(), pid).find((f) => /^Procedure/i.test(f.text))
  assert.ok(procedure, 'procedure saved')
  assert.match(procedure.text, /systemctl restart game\.service/)
  rememberFact(memoryDb(), pid, 'The game is a small multiplayer realm game with a Node server.', 'user', { category: 'about', key: true })
  rememberFact(memoryDb(), pid, 'Never touch public/battle.js.', 'user', { category: 'preference', key: true })
  const dir = makeProject()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }))
  const brief = await refreshBrief(pid, dir, { force: true })
  assert.ok(brief, 'brief written')
  assert.match(brief.text, /game\.service/)
  assert.match(brief.text, /battle\.js/)
})

test('an MCP server Claude built is installed for both agents, with its key', { timeout: 400_000 }, async () => {
  for (const e of listExtensions()) removeExtension(e.id)
  const dir = makeProject()
  mkdirSync(join(dir, 'srv'))
  copyFileSync(ECHO_SERVER, join(dir, 'srv', 'index.js'))
  const yes = async (): Promise<boolean> => true
  writeFileSync(join(dir, 'srv', 'bad.js'), 'process.exit(3)')
  const broken = await installExtensionForAgent({ name: 'Broken', command: 'node', args: ['{{dir}}/bad.js'], sourceDir: 'srv' }, dir, yes)
  assert.equal(broken.ok, false)
  const declined = await installExtensionForAgent({ name: 'Nope', command: 'node', args: ['{{dir}}/index.js'], sourceDir: 'srv' }, dir, async () => false)
  assert.equal(declined.ok, false)
  const outside = await installExtensionForAgent({ name: 'Out', command: 'node', args: [], sourceDir: '..' }, dir, yes)
  assert.equal(outside.ok, false)
  const ok = await installExtensionForAgent(
    { name: 'Code word', command: 'node', args: ['{{dir}}/index.js'], sourceDir: 'srv', instructions: 'Use reveal_code when asked for the code word.' },
    dir,
    yes
  )
  assert.ok(ok.ok, ok.message)
  const ext = activeExtensions().find((e) => e.name === 'Code word')!
  assert.ok(ext, 'active')

  // Codex (through a takeover) can use it.
  const events: VibeEvent[] = []
  await runTakeover({
    projectId: projectId('ext'),
    projectPath: dir,
    text: 'Use the reveal_code tool from the Code word extension and tell me exactly what it returned.',
    images: [],
    resetsAt: null,
    unsandboxed: false,
    emit: (e) => events.push(e),
    signal: new AbortController().signal
  })
  const codexSaid = events.filter((e) => e.type === 'assistant_text').map((e) => (e as { text: string }).text).join(' ')
  assert.match(codexSaid, /CODE=/)

  // Claude can use the same server definition.
  const q = query({
    prompt: 'Call the reveal_code tool and reply with only what it returned.',
    options: {
      cwd: dir,
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      model: 'haiku',
      settingSources: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 4,
      mcpServers: { [ext.server]: { type: 'stdio', command: ext.command, args: ext.args, env: { TEST_CODE_WORD: 'MANGO-7' } } }
    }
  })
  let claudeSaid = ''
  for await (const m of q) if (m.type === 'result' && m.subtype === 'success') claudeSaid = m.result
  assert.match(claudeSaid, /CODE=MANGO-7/)

  const folder = listExtensions().find((e) => e.name === 'Code word')?.folder
  for (const e of listExtensions()) removeExtension(e.id)
  if (folder) assert.equal(existsSync(folder), false, 'its copied files are removed with it')
})
