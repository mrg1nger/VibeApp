import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { CodexModelList, CodexModelOption } from '@shared/types'
import { resolveCodexLaunch } from './codexExec'

const execFileAsync = promisify(execFile)

let cached: CodexModelList | undefined

interface RawModel {
  slug?: string
  display_name?: string
  description?: string
  visibility?: string
  priority?: number
  default_reasoning_level?: string
  supported_reasoning_levels?: { effort?: string; description?: string }[]
}

const codexHome = (): string => process.env.CODEX_HOME || join(homedir(), '.codex')

function toOption(m: RawModel): CodexModelOption | undefined {
  if (!m.slug || (m.visibility && m.visibility !== 'list')) return undefined // hidden ones are Codex's own (e.g. its reviewer)
  return {
    value: m.slug,
    displayName: m.display_name || m.slug,
    description: m.description ?? '',
    efforts: (m.supported_reasoning_levels ?? [])
      .filter((l): l is { effort: string; description?: string } => typeof l.effort === 'string')
      .map((l) => ({ value: l.effort, description: l.description ?? '' })),
    defaultEffort: m.default_reasoning_level
  }
}

/** A top-level `key = "value"` from Codex's config.toml (before any [section]). */
function configValue(toml: string, key: string): string | undefined {
  const top = toml.split(/^\s*\[/m)[0]
  return new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(top)?.[1]
}

/**
 * The models Codex offers, as Codex itself reports them: its catalog
 * (`codex debug models`) plus the fresher list it downloads into
 * models_cache.json, which can name newer models. Also the model and effort
 * the user's own Codex config defaults to.
 */
export async function listCodexModels(): Promise<CodexModelList> {
  if (cached) return cached
  const raw: RawModel[] = []
  try {
    const cache = JSON.parse(readFileSync(join(codexHome(), 'models_cache.json'), 'utf-8')) as { models?: RawModel[] }
    raw.push(...[...(cache.models ?? [])].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)))
  } catch {
    // no downloaded list yet
  }
  try {
    const launch = await resolveCodexLaunch()
    const { stdout } = await execFileAsync(launch.file, [...launch.prefixArgs, 'debug', 'models'], {
      timeout: 20_000,
      windowsHide: true,
      env: launch.env,
      maxBuffer: 32 * 1024 * 1024
    })
    raw.push(...((JSON.parse(stdout) as { models?: RawModel[] }).models ?? []))
  } catch {
    // an older Codex without the command: the downloaded list (if any) is all there is
  }
  const models: CodexModelOption[] = []
  for (const m of raw) {
    const option = toOption(m)
    if (option && !models.some((o) => o.value === option.value)) models.push(option)
  }
  if (!models.length) throw new Error("Codex didn't report any models.")

  const configPath = join(codexHome(), 'config.toml')
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
  cached = {
    models,
    defaultModel: configValue(config, 'model'),
    defaultEffort: configValue(config, 'model_reasoning_effort')
  }
  return cached
}
