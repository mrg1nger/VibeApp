import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeSession } from '../../src/main/orchestrator/session'
import { routeMessage } from '../../src/main/orchestrator/routing'
import { requestClassifier } from '../../src/main/orchestrator/classifier'
import { getSettings, updateSettings } from '../../src/main/settings/store'
import { memoryDb } from '../../src/main/memory/paths'
import { agentUsageSince, codexUsageSince, type RequestLogRow } from '../../src/main/memory/store'
import { runDeploy, saveRecipe } from '../../src/main/deploy/deploy'
import { RequestRecorder } from '../../src/main/usage/requestLog'
import { stepMix, weight } from '../../src/main/usage/report'
import { approvedPlanNote } from '@shared/plan'
import type { AgentBalance } from '@shared/balance'
import type { VibeEvent } from '@shared/types'
import { answerPrompts, makeProject, projectId, turn } from '../support/fixtures'

// The teamwork evaluation: the same small tasks, built for real by Claude and
// Codex the way the app does it (routing note, slider, approved plans, the
// saved Deploy), measuring what each request cost and who did the work, and
// checking the result actually works. Results go to test-results/eval/ and
// are compared with the previous run of the same setup, so a change to the
// instructions or the routing shows up as numbers.
//
//   npm run eval                                   Codex-led, Sonnet
//   VIBEAPP_EVAL_BALANCE=claude npm run eval       Claude-led (for comparison)
//   VIBEAPP_EVAL_MODEL=haiku npm run eval          cheaper, less like real use
//   VIBEAPP_EVAL_ONLY=bugfix npm run eval          only tasks whose name matches
//   VIBEAPP_EVAL_BUILDER=cline npm run eval        Cline builds instead of Codex

const BALANCE = (process.env.VIBEAPP_EVAL_BALANCE ?? 'codex') as AgentBalance
const MODEL = process.env.VIBEAPP_EVAL_MODEL ?? 'sonnet'
const ONLY = process.env.VIBEAPP_EVAL_ONLY ? new RegExp(process.env.VIBEAPP_EVAL_ONLY, 'i') : null
/** cline: the building goes to Cline instead of Codex (the same tasks, to compare the two). */
const BUILDER = process.env.VIBEAPP_EVAL_BUILDER === 'cline' ? 'cline' : 'codex'
const CLINE_BUILDS =
  '[VibeApp note: for this request, hand the implementation to Cline with run_cline_subtask instead of Codex: give it a clear spec, the files and how to check it, then judge its report the way you would judge a Codex hand-off. Don\'t call run_codex_subtask.]'

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'eval-game', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2),
  'shop.js': "// Prices in gold.\nconst prices = { potion: 25, sword: 140, shield: 60 }\n\nfunction buyPrice(item) {\n  if (!(item in prices)) throw new Error(`No such item: ${item}`)\n  return prices[item]\n}\n\nmodule.exports = { prices, buyPrice }\n",
  'shop.test.js': "const { test } = require('node:test')\nconst assert = require('node:assert/strict')\nconst { buyPrice } = require('./shop')\n\ntest('buy prices', () => {\n  assert.equal(buyPrice('sword'), 140)\n  assert.throws(() => buyPrice('dragon'))\n})\n",
  'battle.js': '// Damage dealt by an attack against a defence.\nfunction damage(attack, defence) {\n  return attack * 2 - defence\n}\n\nmodule.exports = { damage }\n',
  'battle.test.js': "const { test } = require('node:test')\nconst assert = require('node:assert/strict')\nconst { damage } = require('./battle')\n\ntest('damage', () => {\n  assert.equal(damage(10, 5), 15)\n})\n"
}

interface Task {
  name: string
  mode: 'build' | 'plan_build'
  text: string
  /** Throws if the result doesn't work. */
  accept: (dir: string, live: string) => void
}

function nodeEval(dir: string, code: string): string {
  return execFileSync(process.execPath, ['-e', code], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf-8' }).trim()
}

function testsPass(dir: string): void {
  execFileSync(process.execPath, ['--test'], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe' })
}

const PLAN = `Add a sell price to the shop, then put the game live.

## Steps
1. (Codex) In shop.js add sellPrice(item): half of buyPrice(item), rounded down, throwing for unknown items like buyPrice does; export it, and add a test for it to shop.test.js. Run the tests.
2. (Claude) Deploy with the saved Deploy.`

const TASKS: Task[] = [
  {
    name: 'feature',
    mode: 'build',
    text: 'Add a sell price to the shop: sellPrice(item) in shop.js gives half the buy price, rounded down, and throws for unknown items like buyPrice does. Add a test for it. Make sure all the tests pass.',
    accept: (dir) => {
      assert.equal(nodeEval(dir, "console.log(require('./shop').sellPrice('sword'))"), '70')
      testsPass(dir)
    }
  },
  {
    name: 'bugfix',
    mode: 'build',
    text: "When a monster's defence is higher than twice the attack, battle damage goes negative and heals it. Damage should never go below 0. Fix it and add a test for it.",
    accept: (dir) => {
      assert.equal(nodeEval(dir, "console.log(require('./battle').damage(1, 10))"), '0')
      assert.equal(nodeEval(dir, "console.log(require('./battle').damage(10, 5))"), '15')
      testsPass(dir)
    }
  },
  {
    name: 'plan-and-deploy',
    mode: 'plan_build',
    text: 'Approved the plan. Go ahead and build it.',
    accept: (dir, live) => {
      assert.equal(nodeEval(dir, "console.log(require('./shop').sellPrice('potion'))"), '12')
      testsPass(dir)
      assert.ok(existsSync(join(live, 'shop.js')) && /sellPrice/.test(readFileSync(join(live, 'shop.js'), 'utf-8')), 'the saved Deploy put the new shop.js live')
    }
  }
]

interface Result {
  task: string
  ok: boolean
  problem?: string
  claudeSteps: number
  claudeWeight: number
  codexWeight: number
  clineWeight?: number
  handoffs: number
  toolCalls: Record<string, number>
  minutes: number
  route: string
}

const results: Result[] = []
after(() => {
  requestClassifier.dispose()
  report()
})

for (const task of TASKS) {
  if (ONLY && !ONLY.test(task.name)) continue
  test(`teamwork eval: ${task.name} (${BALANCE}, ${MODEL}${BUILDER === 'cline' ? ', Cline builds' : ''})`, { timeout: 1_200_000 }, async () => {
    updateSettings({ claudeModel: MODEL, agentBalance: BALANCE, smartRouting: true, aiRouting: true, autoMemory: false, codeMap: false, clineHandoffs: BUILDER === 'cline' })
    const pid = projectId(`eval_${task.name}`)
    const dir = makeProject(FILES)
    const live = mkdtempSync(join(tmpdir(), 'vibeapp-eval-live-'))
    if (task.mode === 'plan_build') {
      // A checked Deploy that copies the game's files to a "live" folder.
      saveRecipe(pid, { name: 'Copy to live', shell: 'bash', steps: [{ label: 'Copy the game files', run: `cp *.js "${live.replace(/\\/g, '/')}/"` }] }, 'user', true)
    }
    const routeText = task.mode === 'plan_build' ? `Build this approved plan:\n${PLAN}` : task.text
    const route = await routeMessage(routeText, getSettings(), { projectId: pid, notQuick: task.mode === 'plan_build' })
    const s = new ClaudeSession(pid, dir)
    answerPrompts(s)
    s.deployRunner = async () => {
      const r = await runDeploy(pid, dir)
      return { ok: r.ok, text: r.ok ? `Deployed in ${r.seconds}s.` : `Failed at "${r.failedStep}": ${r.output ?? ''}` }
    }
    const recorder = new RequestRecorder({ projectId: pid, mode: task.mode, text: task.text, balance: BALANCE, route: route.label ? `${route.label} · ${route.reason ?? ''}` : null, size: route.size })
    let row: RequestLogRow | undefined
    try {
      await s.useModel(route.model).catch(() => undefined)
      const message = [
        route.note,
        BUILDER === 'cline' ? CLINE_BUILDS : undefined,
        task.mode === 'plan_build' ? approvedPlanNote(PLAN) : undefined,
        task.text
      ]
        .filter(Boolean)
        .join('\n\n')
      const events: VibeEvent[] = await turn(s, message, 1_100_000)
      for (const e of events) recorder.observe(e)
      const since = recorder.startedAt.toISOString()
      row = recorder.finish(codexUsageSince(memoryDb(), pid, since), agentUsageSince(memoryDb(), pid, since, 'cline'))
      let problem: string | undefined
      try {
        task.accept(dir, live)
      } catch (err) {
        problem = (err as Error).message.split('\n')[0]
      }
      const progressCalls = events.filter((e) => e.type === 'tool_call' && /plan_progress$/.test(e.name)).length
      results.push({
        task: task.name,
        ok: !problem,
        problem,
        claudeSteps: row.claudeSteps,
        claudeWeight: Math.round(weight(row.claude, row.model)),
        codexWeight: Math.round(weight(row.codex)),
        clineWeight: Math.round(weight(row.cline)),
        handoffs: row.handoffs + (row.tools.cline ?? 0),
        toolCalls: { ...row.tools, ...(task.mode === 'plan_build' ? { progressCalls } : {}) },
        minutes: Math.round(row.seconds / 6) / 10,
        route: row.route ?? '-'
      })
      assert.equal(problem, undefined, `the result works: ${problem}`)
    } finally {
      s.dispose()
    }
  })
}

const k = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`)

/** Prints the results next to the previous run of the same setup, and saves them. */
function report(): void {
  if (!results.length) return
  const outDir = join(process.cwd(), 'test-results', 'eval')
  mkdirSync(outDir, { recursive: true })
  const prefix = `teamwork-${BALANCE}-${MODEL}-${BUILDER === 'cline' ? 'cline-' : ''}`
  // A Codex run's file name has no builder in it, so don't let it match a Cline run's (or the other way round).
  const previousFile = readdirSync(outDir).filter((f) => f.startsWith(prefix) && (BUILDER === 'cline' || !f.slice(prefix.length).startsWith('cline-'))).sort().pop()
  const previous: Result[] = previousFile ? JSON.parse(readFileSync(join(outDir, previousFile), 'utf-8')).results : []
  const file = `${prefix}${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(join(outDir, file), JSON.stringify({ balance: BALANCE, model: MODEL, at: new Date().toISOString(), results }, null, 2))

  const delta = (now: number, before: number | undefined): string => {
    if (before === undefined || before === 0) return ''
    const change = Math.round(((now - before) / before) * 100)
    return ` (${change >= 0 ? '+' : ''}${change}%)`
  }
  console.log(`\nTeamwork eval (${BALANCE}, Claude on ${MODEL})${previousFile ? `, compared with ${previousFile}` : ''}:`)
  for (const r of results) {
    const p = previous.find((x) => x.task === r.task)
    const mix = stepMix(Object.fromEntries(Object.entries(r.toolCalls).filter(([key]) => key !== 'progressCalls')))
    console.log(
      `- ${r.task}: ${r.ok ? 'works' : `BROKEN (${r.problem})`} · Claude ${r.claudeSteps} steps${delta(r.claudeSteps, p?.claudeSteps)}, ${k(r.claudeWeight)}${delta(r.claudeWeight, p?.claudeWeight)} · Codex ${k(r.codexWeight)}${delta(r.codexWeight, p?.codexWeight)}${r.clineWeight ? ` · Cline ${k(r.clineWeight)}` : ''}, ${r.handoffs} hand-off(s) · ${r.minutes} min\n    Claude's tool calls: ${mix}${r.toolCalls.progressCalls !== undefined ? ` · plan ticks: ${r.toolCalls.progressCalls}` : ''}`
    )
  }
  const total = (xs: Result[], f: (r: Result) => number): number => xs.reduce((a, r) => a + f(r), 0)
  const prevSame = previous.filter((p) => results.some((r) => r.task === p.task))
  console.log(
    `Total: Claude ${k(total(results, (r) => r.claudeWeight))}${delta(total(results, (r) => r.claudeWeight), prevSame.length ? total(prevSame, (r) => r.claudeWeight) : undefined)}, Codex ${k(total(results, (r) => r.codexWeight))}. Saved to test-results/eval/${file}`
  )
}
