import { app } from 'electron'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DeployEvent, DeployRecipe, DeployStep } from '@shared/types'
import { detectSecrets } from '@shared/secretPatterns'
import { killTree, trackChild } from '../cli/codexExec'
import { secretEnv } from '../secrets/vault'

// One-click Deploy: each project's own recipe (ordered shell commands, a
// check that the site came back, and optional steps to undo it), written
// once by Claude from how the project has been deployed, checked by the user,
// then run by VibeApp itself with no AI: no usage, and the same every time.

export const deployEvents = new EventEmitter()

const dir = (): string => {
  const d = join(app.getPath('userData'), 'deploy')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}
const recipeFile = (projectId: string): string => join(dir(), `${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

export function getRecipe(projectId: string): DeployRecipe | null {
  try {
    return JSON.parse(readFileSync(recipeFile(projectId), 'utf-8')) as DeployRecipe
  } catch {
    return null
  }
}

const MAX_STEPS = 20
const MAX_COMMAND = 4000

/** Checks a recipe and tidies it. Throws a plain-words error for anything unusable. */
export function cleanRecipe(input: Partial<DeployRecipe>): Omit<DeployRecipe, 'confirmed' | 'updatedAt' | 'by'> {
  const name = String(input.name ?? '').trim().slice(0, 80) || 'Deploy'
  const shell = input.shell === 'powershell' ? 'powershell' : 'bash'
  const steps = (s: unknown): DeployStep[] =>
    (Array.isArray(s) ? s : [])
      .map((x: Partial<DeployStep>) => ({
        label: String(x?.label ?? '').trim().slice(0, 120),
        run: String(x?.run ?? '').trim(),
        timeoutSec: Math.min(3600, Math.max(10, Number(x?.timeoutSec) || 600))
      }))
      .filter((x) => x.run)
      .map((x, i) => ({ ...x, label: x.label || `Step ${i + 1}` }))
  const main = steps(input.steps)
  if (!main.length) throw new Error('A deploy recipe needs at least one step.')
  if (main.length > MAX_STEPS) throw new Error(`At most ${MAX_STEPS} steps.`)
  const rollback = steps(input.rollback).slice(0, MAX_STEPS)
  for (const step of [...main, ...rollback]) {
    if (step.run.length > MAX_COMMAND) throw new Error(`"${step.label}" is longer than ${MAX_COMMAND} characters.`)
    // Keys belong in Secrets (the steps get them as environment variables), never in the recipe.
    if (detectSecrets(step.run).length) {
      throw new Error(`"${step.label}" contains what looks like a secret key. Save it in Secrets and use its name ($NAME) instead.`)
    }
  }
  let check: DeployRecipe['check']
  if (input.check?.url) {
    const url = String(input.check.url).trim()
    if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('The check must be a web address (http:// or https://).')
    check = { url, expectStatus: Number(input.check.expectStatus) || undefined }
  }
  return { name, shell, steps: main, check, rollback: rollback.length ? rollback : undefined, notes: input.notes ? String(input.notes).slice(0, 600) : undefined }
}

/** Saves a recipe. One written by Claude waits for the user to check it before it can run. */
export function saveRecipe(projectId: string, input: Partial<DeployRecipe>, by: 'claude' | 'user', confirmed: boolean): DeployRecipe {
  const recipe: DeployRecipe = { ...cleanRecipe(input), by, confirmed, updatedAt: new Date().toISOString() }
  writeFileSync(recipeFile(projectId), JSON.stringify(recipe, null, 2), 'utf-8')
  deployEvents.emit('changed', projectId)
  if (by === 'claude') deployEvents.emit('recipe-ready', projectId, recipe)
  return recipe
}

export function removeRecipe(projectId: string): void {
  rmSync(recipeFile(projectId), { force: true })
  deployEvents.emit('changed', projectId)
}

/** Git Bash (what the agents' commands, and so the saved procedures, are written for). */
function bashPath(): string | undefined {
  if (process.platform !== 'win32') return '/bin/bash'
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]
  for (const root of roots) {
    if (!root) continue
    for (const rel of [['Git', 'bin', 'bash.exe'], ['Git', 'usr', 'bin', 'bash.exe']]) {
      const p = join(root, ...rel)
      if (existsSync(p)) return p
    }
  }
  return undefined
}

interface Running {
  stop: () => void
  stopped: boolean
}
const running = new Map<string, Running>()

export function isDeploying(projectId: string): boolean {
  return running.has(projectId)
}

export function stopDeploy(projectId: string): void {
  running.get(projectId)?.stop()
}

const OUTPUT_KEEP = 6000

function runStep(
  projectId: string,
  projectPath: string,
  recipe: DeployRecipe,
  step: DeployStep,
  state: Running,
  onOutput: (text: string) => void
): Promise<{ ok: boolean; output: string; code: number | null }> {
  return new Promise((resolve) => {
    const env = { ...process.env, ...secretEnv(projectId), VIBEAPP_DEPLOY: '1' }
    let child: ReturnType<typeof spawn>
    if (recipe.shell === 'powershell') {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', step.run], { cwd: projectPath, env, windowsHide: true })
    } else {
      const bash = bashPath()
      if (!bash) return resolve({ ok: false, output: 'Git Bash was not found (install Git for Windows), so bash steps cannot run.', code: null })
      child = spawn(bash, ['-lc', step.run], { cwd: projectPath, env: { ...env, CHERE_INVOKING: '1' }, windowsHide: true })
    }
    trackChild(child)
    let output = ''
    const add = (chunk: Buffer): void => {
      const text = chunk.toString('utf-8')
      output = (output + text).slice(-OUTPUT_KEEP)
      onOutput(text)
    }
    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    const timer = setTimeout(() => {
      add(Buffer.from(`\n(VibeApp stopped this step after ${step.timeoutSec ?? 600} seconds)\n`))
      killTree(child)
    }, (step.timeoutSec ?? 600) * 1000)
    state.stop = () => {
      state.stopped = true
      killTree(child)
    }
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, output: `${output}\n${err.message}`, code: null })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0 && !state.stopped, output, code })
    })
  })
}

async function checkSite(url: string, expectStatus: number | undefined, state: Running): Promise<{ ok: boolean; detail: string }> {
  let last = ''
  // A restarting service takes a moment: several tries, a few seconds apart (a 502 mid-restart isn't a failure).
  for (let attempt = 1; attempt <= 8 && !state.stopped; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) })
      last = `HTTP ${res.status}`
      if (expectStatus ? res.status === expectStatus : res.status >= 200 && res.status < 400) return { ok: true, detail: `${url} answered ${last}` }
    } catch (err) {
      last = (err as Error).message
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  return { ok: false, detail: `${url} didn't come back (last: ${last})` }
}

export interface DeployResult {
  ok: boolean
  seconds: number
  failedStep?: string
  output?: string
  checkDetail?: string
  rolledBack?: boolean
  stopped?: boolean
}

/** Runs the project's recipe, step by step, reporting each through deployEvents ('event'). */
export async function runDeploy(projectId: string, projectPath: string): Promise<DeployResult> {
  const recipe = getRecipe(projectId)
  if (!recipe) throw new Error('This project has no deploy recipe yet.')
  if (!recipe.confirmed) throw new Error('Check the deploy recipe and save it before running it.')
  if (running.has(projectId)) throw new Error('A deploy is already running for this project.')
  const state: Running = { stop: () => undefined, stopped: false }
  running.set(projectId, state)
  const started = Date.now()
  const emit = (event: DeployEvent): void => {
    deployEvents.emit('event', projectId, event)
  }
  try {
    emit({ type: 'started', steps: recipe.steps.map((s) => s.label), hasCheck: !!recipe.check })
    for (let i = 0; i < recipe.steps.length; i++) {
      const step = recipe.steps[i]
      emit({ type: 'step', index: i, status: 'running' })
      const result = await runStep(projectId, projectPath, recipe, step, state, (text) => emit({ type: 'output', index: i, text }))
      emit({ type: 'step', index: i, status: result.ok ? 'ok' : 'failed' })
      if (!result.ok) {
        const rolledBack = !state.stopped && (await rollback(projectId, projectPath, recipe, state, emit))
        const done: DeployResult = { ok: false, seconds: secondsSince(started), failedStep: step.label, output: result.output.slice(-2500), rolledBack, stopped: state.stopped }
        emit({ type: 'finished', ...done })
        return done
      }
    }
    if (recipe.check) {
      emit({ type: 'check', status: 'running' })
      const check = await checkSite(recipe.check.url, recipe.check.expectStatus, state)
      emit({ type: 'check', status: check.ok ? 'ok' : 'failed', detail: check.detail })
      if (!check.ok) {
        const rolledBack = !state.stopped && (await rollback(projectId, projectPath, recipe, state, emit))
        const done: DeployResult = { ok: false, seconds: secondsSince(started), failedStep: 'Site check', checkDetail: check.detail, rolledBack, stopped: state.stopped }
        emit({ type: 'finished', ...done })
        return done
      }
      const done: DeployResult = { ok: true, seconds: secondsSince(started), checkDetail: check.detail }
      emit({ type: 'finished', ...done })
      return done
    }
    const done: DeployResult = { ok: true, seconds: secondsSince(started) }
    emit({ type: 'finished', ...done })
    return done
  } finally {
    running.delete(projectId)
  }
}

const secondsSince = (t: number): number => Math.round((Date.now() - t) / 1000)

async function rollback(
  projectId: string,
  projectPath: string,
  recipe: DeployRecipe,
  state: Running,
  emit: (event: DeployEvent) => void
): Promise<boolean> {
  if (!recipe.rollback?.length) return false
  emit({ type: 'rollback', status: 'running' })
  for (const step of recipe.rollback) {
    const result = await runStep(projectId, projectPath, recipe, step, state, (text) => emit({ type: 'output', index: -1, text }))
    if (!result.ok) {
      emit({ type: 'rollback', status: 'failed', detail: `"${step.label}" failed too` })
      return false
    }
  }
  emit({ type: 'rollback', status: 'ok' })
  return true
}
