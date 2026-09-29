import { THEME_VARS, type ThemeDefinition } from '@shared/types'

/** Applies a theme by setting its whitelisted CSS custom properties on the root element. */
export function applyTheme(theme: ThemeDefinition): void {
  const root = document.documentElement.style
  for (const key of THEME_VARS) {
    root.setProperty(`--${key}`, theme.vars[key])
  }
  document.documentElement.dataset.theme = theme.id
}
