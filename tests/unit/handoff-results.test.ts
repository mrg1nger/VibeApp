import { test } from 'node:test'
import assert from 'node:assert/strict'
import { digestDiff } from '../../src/main/delegation/diffDigest'
import { describeActivity, scrubSecrets } from '../../src/main/cli/codexActivity'
import { cleanCommand, isNotableCommand } from '../../src/main/memory/commands'

function hunk(start: number, lines: string[]): string {
  return `@@ -${start},3 +${start},${3 + lines.length} @@\n context\n${lines.map((l) => '+' + l).join('\n')}\n context\n`
}
function file(name: string, hunks: string[]): string {
  return `diff --git a/${name} b/${name}\nindex 111..222 100644\n--- a/${name}\n+++ b/${name}\n${hunks.join('')}`
}
const filler = Array.from({ length: 25 }, (_, i) => `  const filler${i} = computeSomethingBoring(${i}) // padding ${i}`)

test('a big diff becomes a digest that lists every file and leads with the relevant changes', () => {
  const diff =
    file('src/cart.js', [hunk(10, ['function applyDiscount(cart, code) { return cart.total * 0.9 }', ...filler]), hunk(80, filler)]) +
    file('src/theme.css', [hunk(1, filler), hunk(40, filler)]) +
    file('src/api/orders.js', [hunk(5, ['async function submitOrder(cart) { return fetch("/orders") }', ...filler])])
  const changes = [
    { path: 'src/cart.js', added: 52, removed: 0 },
    { path: 'src/theme.css', added: 50, removed: 0 },
    { path: 'src/api/orders.js', added: 26, removed: 0 }
  ]
  const out = digestDiff(diff, changes, 'add a discount code to the cart', new Map([['src/cart.js', 'Cart totals']]))
  assert.ok(out.length < diff.length / 2, 'digest is much smaller than the diff')
  for (const f of ['src/cart.js', 'src/theme.css', 'src/api/orders.js']) assert.ok(out.includes(f), `lists ${f}`)
  assert.ok(out.includes('Cart totals'), 'includes the code map description')
  assert.ok(out.includes('applyDiscount'), 'shows the relevant hunk')
  assert.ok(out.indexOf('applyDiscount') < (out.indexOf('--- src/theme.css') === -1 ? Infinity : out.indexOf('--- src/theme.css')))
  assert.match(out, /more change/)
})

test('commands worth remembering are picked out and scrubbed', () => {
  assert.equal(isNotableCommand('cd "yay" && git archive --format=tar.gz master | ssh root@host "tar xz"'), true)
  assert.equal(isNotableCommand('ssh root@$HOST "systemctl restart glyphlands.service"'), true)
  assert.equal(isNotableCommand('git status --short'), false)
  assert.equal(isNotableCommand('ls -la'), false)
  const key = 'sk-ant-' + 'a'.repeat(30)
  assert.ok(!cleanCommand(`curl -H "x-api-key: ${key}" https://api.example.com`).includes(key))
  assert.ok(!scrubSecrets(`token ${key}`).includes(key))
})

test("Codex's own helper agents show up readably in the live feed", () => {
  const step = describeActivity({
    type: 'item.started',
    item: { id: 'i1', type: 'collab_tool_call', tool: 'spawn_agent', prompt: 'Read shop.js', status: 'in_progress' }
  })
  assert.ok(step && step.text.startsWith('Helper agent - spawn_agent'), JSON.stringify(step))
  const run = describeActivity({
    type: 'item.completed',
    item: { id: 'i2', type: 'command_execution', command: 'npm test', exit_code: 1, aggregated_output: 'fail' }
  })
  assert.equal(run?.ok, false)
})
