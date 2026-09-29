import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { THEME_VARS, type ThemeDefinition } from '@shared/types'
import { resolveClaudeExecutable } from '../cli/claudeBinary'
import { getSettings } from '../settings/store'
import { BUILT_IN_THEMES } from './builtin'
import { saveTheme, validateTheme } from './store'

const THEME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short theme name, 1-4 words.' },
    description: { type: 'string', description: 'One sentence describing the vibe.' },
    thinkingLabel: {
      type: 'string',
      description: 'Status text shown while Claude works, in the theme\'s voice (under 40 chars).'
    },
    vars: {
      type: 'object',
      properties: Object.fromEntries(THEME_VARS.map((v) => [v, { type: 'string' }])),
      required: [...THEME_VARS],
      additionalProperties: false
    }
  },
  required: ['name', 'description', 'thinkingLabel', 'vars'],
  additionalProperties: false
}

function buildPrompt(description: string): string {
  const examples = BUILT_IN_THEMES.map((t) => JSON.stringify({ name: t.name, thinkingLabel: t.thinkingLabel, vars: t.vars }, null, 1)).join('\n\n')
  return `Design a color theme for VibeApp, a desktop app for chatting with AI coding agents.

The user wants: ${description}

A theme is a set of CSS custom property values. Rules:
- Every value must be a plain CSS value: colors (hex, rgb/rgba, hsl), gradients (linear-/radial-/repeating-*-gradient), lengths, font stacks, box-shadows, or "none".
- Never use url(), image-set(), @import, semicolons, braces, angle brackets or backslashes. No external images or fonts; only fonts likely installed on Windows.
- font: a font-family stack. radius: a length like 8px.
- bg: solid page color. bg-image: decorative layered gradients drawn over bg, or "none".
- surface / surface-raised / surface-sunken: panel, button and input backgrounds (surface may be semi-transparent so bg-image shows through).
- text must be clearly readable on bg and every surface; text-muted a bit dimmer but still readable.
- accent: main action color; accent-text must be readable on accent. accent-glow: a box-shadow or "none".
- title: a gradient used as the app title's text fill (use linear-gradient(c, c) for a solid color).
- user-bubble: background of the user's chat messages (color or gradient), with accent-text on it.
- success/warning/danger/delegation: badge and banner colors; each *-text readable on its *-bg.
- overlay: translucent backdrop behind dialogs.

Here are the two built-in themes for reference:

${examples}

Be creative and make it match the request, while keeping everything readable.`
}

/** Asks Claude to design a theme from a description, then validates and saves it as an extension. */
export async function generateTheme(description: string): Promise<ThemeDefinition> {
  const request = description.trim().slice(0, 500)
  if (!request) throw new Error('Describe the theme you want first.')

  // Throwaway working dir: no tools are enabled, but keep Claude Code from
  // picking up any project's CLAUDE.md or settings.
  const cwd = mkdtempSync(join(tmpdir(), 'vibeapp-theme-'))
  try {
    const q = query({
      prompt: buildPrompt(request),
      options: {
        cwd,
        pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        model: getSettings().claudeModel ?? undefined,
        tools: [],
        maxTurns: 3,
        outputFormat: { type: 'json_schema', schema: THEME_SCHEMA }
      }
    })
    for await (const message of q) {
      if (message.type !== 'result') continue
      if (message.subtype !== 'success') {
        throw new Error(`Theme generation failed (${message.subtype}).`)
      }
      if (!message.structured_output) throw new Error('Claude didn\'t return a theme.')
      const theme = validateTheme(message.structured_output, 'generated')
      return saveTheme(theme)
    }
    throw new Error('Theme generation ended without a result.')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}
