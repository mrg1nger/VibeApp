import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'os'
import { join } from 'path'
import { isReadOnlyCommand, planModeBlock } from '../../src/main/orchestrator/planGuard'

const bash = (c: string): boolean => isReadOnlyCommand(c, 'bash')
const ps = (c: string): boolean => isReadOnlyCommand(c, 'powershell')

test('planning may look: reading tools, questions, memory and drafts', () => {
  for (const name of ['Read', 'Glob', 'Grep', 'WebFetch', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'Agent', 'ToolSearch']) {
    assert.equal(planModeBlock(name, {}), undefined, name)
  }
  assert.equal(planModeBlock('mcp__vibe_memory__recall', { query: 'deploy' }), undefined)
  assert.equal(planModeBlock('mcp__vibe_memory__add_todo', { text: 'x' }), undefined, 'to-dos, as in Ask')
  assert.equal(planModeBlock('mcp__vibe_tools__save_deploy_recipe', {}), undefined, 'a draft the user checks')
  assert.equal(planModeBlock('mcp__vibe_tools__save_schedule', {}), undefined, 'a draft the user turns on')
  assert.equal(planModeBlock('mcp__vibe_tools__leave_plan_mode', {}), undefined)
  assert.equal(planModeBlock('mcp__playwright__browser_snapshot', {}), undefined)
  assert.equal(planModeBlock('mcp__playwright__browser_navigate', { url: 'http://localhost:5173' }), undefined)
  assert.equal(planModeBlock('mcp__context7__get-library-docs', {}), undefined)
})

test("planning may write Claude Code's own plan file, and nothing else", () => {
  assert.equal(planModeBlock('Write', { file_path: join(homedir(), '.claude', 'plans', 'quiet-fox.md') }), undefined)
  assert.match(planModeBlock('Edit', { file_path: 'C:\\Users\\me\\Game\\src\\player.js' }) ?? '', /change src\/player\.js/)
  assert.ok(planModeBlock('Write', { file_path: join(homedir(), '.claude', 'plans', 'x.sh') }))
  assert.ok(planModeBlock('NotebookEdit', { notebook_path: 'a.ipynb' }))
})

test('planning may not act: Deploy, hand-offs, installing, clicking on a live site', () => {
  assert.equal(planModeBlock('mcp__vibe_tools__run_deploy', {}), 'run the Deploy')
  assert.equal(planModeBlock('mcp__vibe_tools__run_codex_subtask', {}), 'hand work to Codex')
  assert.equal(planModeBlock('mcp__vibe_tools__run_cline_subtask', {}), 'hand work to Cline')
  assert.equal(planModeBlock('mcp__vibe_tools__install_extension', {}), 'install a tool')
  assert.ok(planModeBlock('mcp__playwright__browser_click', {}))
  assert.ok(planModeBlock('mcp__playwright__browser_type', {}))
  assert.ok(planModeBlock('mcp__someserver__delete_user', {}))
  assert.ok(planModeBlock('SomeNewTool', {}), 'unknown tools count as acting')
})

test('the commands from the DevBox plan request are turned away', () => {
  // What a "done" sent in Plan mode ran on 2026-11-09 (ssh to production, a migration).
  assert.equal(bash('ssh -i /c/Users/me/Downloads/id_ed25519 oton@1.2.3.4 \'sudo -u postgres psql -d app -c "\\dt"\''), false)
  assert.equal(bash('tar -cf - server/migrations | ssh -i key host "tar -xf - -C /srv/app && npm run migrate"'), false)
  assert.equal(bash('scp dist.tar host:/srv'), false)
  assert.match(planModeBlock('Bash', { command: 'ssh host uptime' }) ?? '', /^run a command: ssh host uptime/)
})

test('read-only shell commands are fine while planning', () => {
  for (const c of [
    'ls -la src',
    'git status',
    'git log --oneline -20',
    'git -C ../other diff HEAD~1 -- src',
    'git branch -a',
    'git remote -v',
    'cat package.json | jq .scripts',
    'grep -rn "potion" src | head -20',
    'rg "a|b" src',
    'find . -name "*.ts" -not -path "./node_modules/*"',
    'wc -l src/*.ts 2>/dev/null',
    'cd server && ls',
    'node --version',
    'npm ls --depth=0',
    'curl -s https://example.com/api/health',
    'curl -sI -X HEAD https://example.com',
    'echo "x > y" | grep x'
  ]) {
    assert.equal(bash(c), true, c)
  }
  for (const c of [
    'Get-ChildItem -Recurse -Filter *.ts | Select-Object -First 5',
    'Get-Content package.json | ConvertFrom-Json',
    'Select-String -Path src\\*.ts -Pattern "potion"',
    '$files = Get-ChildItem src; $files.Count',
    'Test-Path .\\dist 2>$null',
    'Get-ChildItem | Where-Object { $_.Length -gt 1000 } | ForEach-Object { $_.Name }'
  ]) {
    assert.equal(ps(c), true, c)
  }
})

test('commands that change something, or might, are turned away', () => {
  for (const c of [
    'echo hi > made.txt',
    'cat a >> b',
    'rm -rf dist',
    'mkdir build',
    'npm install',
    'npm run build',
    'npm test',
    'npx vite build',
    'node -e "require(\'fs\').writeFileSync(\'x\', \'1\')"',
    'python script.py',
    'git commit -m x',
    'git push',
    'git checkout -- .',
    'git branch -D old',
    'git -c core.pager=evil log',
    'git diff --output=patch.txt',
    'git stash',
    'sed -i s/a/b/ file',
    'find . -name "*.log" -delete',
    'find . -exec rm {} \\;',
    'curl -X POST https://example.com/api/admin/users/1/suspend',
    'curl -d "a=1" https://example.com',
    'curl -o out.bin https://example.com/file',
    'curl -sO https://example.com/file',
    'echo $(rm x)',
    'echo `rm x`',
    'sleep 100 &',
    'env FOO=1 rm x',
    'FOO=1 npm run deploy',
    'xargs rm < list.txt',
    'sudo systemctl restart api'
  ]) {
    assert.equal(bash(c), false, c)
  }
  for (const c of [
    'Remove-Item -Recurse dist',
    'Set-Content a.txt "x"',
    'Get-ChildItem | ForEach-Object { Remove-Item $_ }',
    'Get-ChildItem *.log | % { rm $_ }',
    'Copy-Item a b',
    'Start-Process notepad',
    'Invoke-WebRequest -Method Post https://example.com',
    'Get-Process | Stop-Process',
    '[IO.File]::WriteAllText("a", "b")',
    'Get-Content a | Out-File b',
    'Get-Content a | Tee-Object b',
    'npm run build; Get-ChildItem'
  ]) {
    assert.equal(ps(c), false, c)
  }
})
