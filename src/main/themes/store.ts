import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { THEME_VARS, type ThemeDefinition, type ThemeVar } from '@shared/types'
import { BUILT_IN_THEMES } from './builtin'

/** Theme extensions: one JSON file per theme, droppable by hand or written by the generator. */
export function themesDir(): string {
  const dir = join(app.getPath('userData'), 'themes')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// Themes only ever become CSS custom property values (set via
// style.setProperty, so they can't break out into other rules). Still reject
// anything that could load resources or isn't plausibly a style value.
const UNSAFE_VALUE = /url\s*\(|image-set\s*\(|expression\s*\(|@import|[;{}<>\\]/i

export function validateTheme(raw: unknown, source: ThemeDefinition['source']): ThemeDefinition {
  const t = raw as Partial<ThemeDefinition> & { vars?: Record<string, unknown> }
  if (!t || typeof t.name !== 'string' || !t.name.trim()) throw new Error('Theme needs a name.')
  if (!t.vars || typeof t.vars !== 'object') throw new Error('Theme needs a vars object.')
  const vars = {} as Record<ThemeVar, string>
  for (const key of THEME_VARS) {
    const value = t.vars[key]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Theme is missing "${key}".`)
    if (value.length > 600 || UNSAFE_VALUE.test(value)) throw new Error(`Theme value for "${key}" isn't allowed.`)
    vars[key] = value.trim()
  }
  const name = t.name.trim().slice(0, 60)
  return {
    id: typeof t.id === 'string' && /^[a-z0-9-]{1,60}$/.test(t.id) ? t.id : slug(name),
    name,
    description: typeof t.description === 'string' ? t.description.slice(0, 200) : undefined,
    thinkingLabel:
      typeof t.thinkingLabel === 'string' && t.thinkingLabel.trim()
        ? t.thinkingLabel.trim().slice(0, 80)
        : undefined,
    source,
    vars
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'theme'
}

export function listThemes(): ThemeDefinition[] {
  const custom: ThemeDefinition[] = []
  for (const file of readdirSync(themesDir()).filter((f) => f.endsWith('.json'))) {
    try {
      const raw = JSON.parse(readFileSync(join(themesDir(), file), 'utf-8'))
      const source = raw?.source === 'generated' ? 'generated' : 'custom'
      custom.push({ ...validateTheme(raw, source), id: file.replace(/\.json$/, '') })
    } catch {
      // Skip a broken extension rather than failing the whole list.
    }
  }
  const builtInIds = new Set(BUILT_IN_THEMES.map((t) => t.id))
  return [...BUILT_IN_THEMES, ...custom.filter((t) => !builtInIds.has(t.id))]
}

/** Saves a theme as an extension file, picking a unique id. */
export function saveTheme(theme: ThemeDefinition): ThemeDefinition {
  const taken = new Set(listThemes().map((t) => t.id))
  let id = theme.id
  for (let n = 2; taken.has(id); n++) id = `${theme.id}-${n}`
  const saved = { ...theme, id }
  writeFileSync(join(themesDir(), `${id}.json`), JSON.stringify(saved, null, 2), 'utf-8')
  return saved
}

export function deleteTheme(id: string): void {
  if (BUILT_IN_THEMES.some((t) => t.id === id)) throw new Error("Built-in themes can't be deleted.")
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid theme id.')
  rmSync(join(themesDir(), `${id}.json`), { force: true })
}
