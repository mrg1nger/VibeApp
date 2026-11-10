import { after, test } from 'node:test'
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runCline } from '../../src/main/cli/clineExec'
import { listClineModels, stopHostedCline } from '../../src/main/cli/clineAcp'
import { makeProject } from '../support/fixtures'

// The hand-off evaluation for Cline's models: small real coding tasks, run the way a
// hand-off runs (hosted Cline, VibeApp's hook and permission rules), scored on the
// project's own tests passing afterwards. Uses ClinePass only (no Claude).
//
//   npm run eval -- cline-coding                         every ClinePass model offered now
//   VIBEAPP_EVAL_CLINE_MODELS="cline-pass/kimi-k3.1-pro,cline-pass/glm-5.3" npm run eval -- cline-coding

const MINUTES = 60_000

interface Task {
  name: string
  files: Record<string, string>
  prompt: string
  /** What's wrong afterwards, or null. */
  check: (dir: string) => string | null
}

const npmTest = (dir: string): string | null => {
  // Without this, a project's own `node --test` run from inside this test runner reports
  // to it instead and exits 0 even when its tests fail (found: everything "passed").
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  try {
    execFileSync('npm', ['test', '--silent'], { cwd: dir, env, stdio: 'pipe', shell: true, timeout: 60_000, windowsHide: true })
    return null
  } catch (err) {
    const out = String((err as { stdout?: Buffer }).stdout ?? '') + String((err as { stderr?: Buffer }).stderr ?? '')
    return `npm test fails: ${out.replace(/\s+/g, ' ').slice(-160)}`
  }
}

const TASKS: Task[] = [
  {
    name: 'fix a bug',
    files: {
      'math.js': 'function add(a, b) {\n  return a - b\n}\n\nfunction double(n) {\n  return add(n, n)\n}\n\nmodule.exports = { add, double }\n',
      'math.test.js': "const test = require('node:test')\nconst assert = require('node:assert')\nconst { add, double } = require('./math')\ntest('add', () => assert.strictEqual(add(2, 3), 5))\ntest('double', () => assert.strictEqual(double(4), 8))\n",
      'package.json': JSON.stringify({ name: 'm', version: '1.0.0', scripts: { test: 'node --test' } })
    },
    prompt: 'The tests fail: add() in math.js is wrong. Fix it, then run npm test to check.',
    check: (dir) => npmTest(dir)
  },
  {
    name: 'add a feature the tests expect',
    files: {
      'cart.js': '// A shopping cart: items are { name, price, qty }.\nfunction addItem(cart, item) {\n  return [...cart, item]\n}\n\nmodule.exports = { addItem }\n',
      'cart.test.js':
        "const test = require('node:test')\nconst assert = require('node:assert')\nconst { addItem, total } = require('./cart')\ntest('addItem', () => assert.strictEqual(addItem([], { name: 'a', price: 1, qty: 1 }).length, 1))\ntest('total sums price times qty', () => assert.strictEqual(total([{ name: 'a', price: 2.5, qty: 2 }, { name: 'b', price: 1, qty: 3 }]), 8))\ntest('total of an empty cart is 0', () => assert.strictEqual(total([]), 0))\n",
      'package.json': JSON.stringify({ name: 'c', version: '1.0.0', scripts: { test: 'node --test' } })
    },
    prompt: 'Add a total(cart) function to cart.js that returns the sum of price times qty for every item (0 for an empty cart), export it, and make npm test pass. Don\'t change the tests.',
    check: (dir) => {
      if (!/total sums price times qty/.test(readFileSync(join(dir, 'cart.test.js'), 'utf8'))) return 'changed the tests'
      return npmTest(dir)
    }
  },
  {
    name: 'rename across two files',
    files: {
      'prices.js': "const PRICES = { potion: 25, sword: 140 }\nfunction getPrice(item) {\n  return PRICES[item] ?? 0\n}\nmodule.exports = { getPrice }\n",
      'shop.js': "const { getPrice } = require('./prices')\nfunction quote(items) {\n  return items.reduce((sum, i) => sum + getPrice(i), 0)\n}\nmodule.exports = { quote }\n",
      'shop.test.js': "const test = require('node:test')\nconst assert = require('node:assert')\nconst { quote } = require('./shop')\nconst prices = require('./prices')\ntest('quote', () => assert.strictEqual(quote(['potion', 'sword']), 165))\ntest('priceOf is exported', () => assert.strictEqual(prices.priceOf('potion'), 25))\ntest('getPrice is gone', () => assert.strictEqual(prices.getPrice, undefined))\n",
      'package.json': JSON.stringify({ name: 's', version: '1.0.0', scripts: { test: 'node --test' } })
    },
    prompt: 'Rename the function getPrice to priceOf everywhere (prices.js and shop.js), keeping everything working. Run npm test to check.',
    check: (dir) => {
      const leftover = ['prices.js', 'shop.js'].filter((f) => /getPrice/.test(readFileSync(join(dir, f), 'utf8')))
      if (leftover.length) return `getPrice still in ${leftover.join(', ')}`
      return npmTest(dir)
    }
  }
]

interface Row {
  model: string
  passed: number
  total: number
  failures: string[]
  seconds: number
  tokens: number
}

const rows: Row[] = []
after(() => {
  stopHostedCline()
  if (!rows.length) return
  const dir = join(process.cwd(), 'test-results', 'eval')
  mkdirSync(dir, { recursive: true })
  const file = `cline-coding-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(join(dir, file), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2))
  console.log('\nCline hand-off eval (coding):')
  for (const r of [...rows].sort((a, b) => b.passed - a.passed || a.seconds - b.seconds)) {
    console.log(`- ${r.model}: ${r.passed}/${r.total} · ${r.seconds.toFixed(0)} s per task · ${Math.round(r.tokens / r.total / 1000)}k tokens per task${r.failures.length ? `\n    ${r.failures.join('\n    ')}` : ''}`)
  }
  console.log(`Saved to test-results/eval/${file}`)
})

test('each task fails before any work (so a pass means the model did it)', () => {
  for (const task of TASKS) {
    const problem = task.check(makeProject(task.files))
    if (!problem) throw new Error(`"${task.name}" passes untouched: its check is broken`)
  }
})

test('hand-offs: every model on the coding tasks', { timeout: 240 * MINUTES }, async () => {
  const chosen = process.env.VIBEAPP_EVAL_CLINE_MODELS?.split(',').map((m) => m.trim()).filter(Boolean)
  const list = chosen ?? (await listClineModels(true)).models.map((m) => m.id)
  console.log(`  models: ${list.join(', ')}`)
  for (const model of list) {
    const row: Row = { model, passed: 0, total: TASKS.length, failures: [], seconds: 0, tokens: 0 }
    for (const task of TASKS) {
      const dir = makeProject(task.files)
      const started = Date.now()
      let problem: string | null
      try {
        const result = await runCline({ prompt: task.prompt, mode: 'build', cwd: dir, model, timeoutMs: 4 * MINUTES })
        row.tokens += result.usage.fresh + result.usage.cached + result.usage.output
        problem = task.check(dir)
        if (problem && !result.ok) problem = `${problem} (Cline: ${(result.error ?? '').slice(0, 120)})`
      } catch (err) {
        problem = `failed: ${(err as Error).message.slice(0, 120)}`
      }
      row.seconds += (Date.now() - started) / 1000
      if (problem) row.failures.push(`${task.name}: ${problem}`)
      else row.passed++
      stopHostedCline() // one project per task: don't keep its Cline around
    }
    row.seconds /= TASKS.length
    rows.push(row)
    console.log(`  ${model}: ${row.passed}/${row.total}, ${row.seconds.toFixed(0)} s per task`)
  }
})
