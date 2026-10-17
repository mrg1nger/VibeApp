import { test } from 'node:test'
import assert from 'node:assert/strict'
import { staysInProject } from '../../src/main/orchestrator/commandScope'

const project = 'C:\\Users\\me\\Projects\\game'

test('ordinary commands inside the project need no prompt', () => {
  for (const command of [
    'node inventory.test.js',
    'npm test',
    'cd "C:\\Users\\me\\Projects\\game"; node --test',
    'cd /c/Users/me/Projects/game && npm run build',
    'git status --short > /dev/null',
    'node C:/Users/me/Projects/game/scripts/check.js'
  ]) {
    assert.equal(staysInProject(command, project), true, command)
  }
})

test('commands that reach outside the project still ask', () => {
  for (const command of [
    'type C:\\Users\\me\\.ssh\\id_rsa',
    'cat ~/.ssh/id_rsa',
    'Get-Content $env:USERPROFILE\\secrets.txt',
    'cd ..; dir',
    'node ../other/script.js',
    'copy game.js D:\\backup\\',
    'ls /etc',
    'dir \\\\server\\share\\',
    'cd "C:\\Users\\me\\Projects\\game-other"; npm test',
    ''
  ]) {
    assert.equal(staysInProject(command, project), false, command)
  }
})
