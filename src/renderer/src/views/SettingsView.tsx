import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, ModelOption, ThemeDefinition } from '@shared/types'

interface SettingsViewProps {
  settings: AppSettings
  themes: ThemeDefinition[]
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
  onThemesChange: () => Promise<void>
  onError: (message: string) => void
}

const SWATCH_VARS = ['bg', 'surface', 'accent', 'text', 'success-text', 'delegation-text'] as const

function SettingsView({ settings, themes, onSettingsChange, onThemesChange, onError }: SettingsViewProps) {
  const [models, setModels] = useState<ModelOption[] | null>(null)
  const [modelsError, setModelsError] = useState(false)
  const [codexModel, setCodexModel] = useState(settings.codexModel ?? '')
  const [themePrompt, setThemePrompt] = useState('')
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    window.vibe.models
      .claude()
      .then(setModels)
      .catch(() => setModelsError(true))
  }, [])

  const saveCodexModel = useCallback(() => {
    const value = codexModel.trim() || null
    if (value !== settings.codexModel) onSettingsChange({ codexModel: value }).catch(() => undefined)
  }, [codexModel, settings.codexModel, onSettingsChange])

  const handleGenerate = useCallback(async () => {
    const description = themePrompt.trim()
    if (!description) return
    setGenerating(true)
    try {
      const theme = await window.vibe.themes.generate(description)
      await onThemesChange()
      await onSettingsChange({ themeId: theme.id })
      setThemePrompt('')
    } catch (err) {
      onError(`Couldn't generate that theme: ${(err as Error).message}`)
    } finally {
      setGenerating(false)
    }
  }, [themePrompt, onThemesChange, onSettingsChange, onError])

  const handleDelete = useCallback(
    async (theme: ThemeDefinition) => {
      try {
        if (settings.themeId === theme.id) await onSettingsChange({ themeId: 'midnight' })
        await window.vibe.themes.delete(theme.id)
        await onThemesChange()
      } catch (err) {
        onError((err as Error).message)
      }
    },
    [settings.themeId, onSettingsChange, onThemesChange, onError]
  )

  // Keep a saved model visible even if it's no longer in the account's list.
  const claudeOptions =
    models && settings.claudeModel && !models.some((m) => m.value === settings.claudeModel)
      ? [...models, { value: settings.claudeModel, displayName: settings.claudeModel, description: '' }]
      : (models ?? [])

  return (
    <div className="settings-view">
      <h2>Settings</h2>

      <section className="settings-section">
        <h3>Models</h3>
        <label className="settings-field">
          <span>Claude (runs your chats)</span>
          <select
            value={settings.claudeModel ?? ''}
            onChange={(e) => onSettingsChange({ claudeModel: e.target.value || null }).catch(() => undefined)}
            disabled={!models && !modelsError}
          >
            <option value="">Account default</option>
            {claudeOptions.map((m) => (
              <option key={m.value} value={m.value}>
                {m.displayName}
                {m.description ? ` — ${m.description}` : ''}
              </option>
            ))}
          </select>
          {!models && !modelsError && <small>Loading models…</small>}
          {modelsError && <small>Couldn't load the model list. Is Claude Code logged in?</small>}
          <small>Changes apply to open chats right away.</small>
        </label>

        <label className="settings-field">
          <span>Codex (helper for delegated tasks)</span>
          <input
            value={codexModel}
            onChange={(e) => setCodexModel(e.target.value)}
            onBlur={saveCodexModel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveCodexModel()
            }}
            placeholder="Default (from your Codex config)"
          />
          <small>A Codex model name like gpt-5-codex. Leave blank for Codex's default.</small>
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.smartRouting}
            onChange={(e) => onSettingsChange({ smartRouting: e.target.checked }).catch(() => undefined)}
          />
          <span>
            Smart model switching
            <small>
              Never goes above the model you chose. Uses Haiku for quick edits, switches to Sonnet when your
              Claude plan runs low, and hands suitable work to Codex (less when Codex is running low). Chats
              show a ⚡ badge when it steps in; hover it to see why.
            </small>
          </span>
        </label>

        <label className="settings-toggle settings-subtoggle">
          <input
            type="checkbox"
            checked={settings.stepUpForComplex}
            disabled={!settings.smartRouting}
            onChange={(e) => onSettingsChange({ stepUpForComplex: e.target.checked }).catch(() => undefined)}
          />
          <span>
            Step up to Opus for complex requests
            <small>
              Only matters if you chose a lighter model (Sonnet or Haiku-class): complex requests use Opus
              instead. Uses more of your Claude plan. Off: your chosen model is the most that's ever used.
            </small>
          </span>
        </label>

        <label className="settings-toggle settings-subtoggle">
          <input
            type="checkbox"
            checked={settings.aiRouting}
            disabled={!settings.smartRouting}
            onChange={(e) => onSettingsChange({ aiRouting: e.target.checked }).catch(() => undefined)}
          />
          <span>
            Let Haiku judge each request
            <small>
              Haiku reads each message (about a second, a sliver of Claude usage) to decide how big it is and
              how much suits Codex. Off: quicker keyword rules, which can misjudge unusual wording.
            </small>
          </span>
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.codeMap}
            onChange={(e) => onSettingsChange({ codeMap: e.target.checked }).catch(() => undefined)}
          />
          <span>
            Keep a map of your code
            <small>
              Haiku writes a one-line summary of each source file (only for files that changed), so Claude and
              Codex can find where things live with one search instead of exploring the project. Uses a little
              Claude usage in the background after requests.
            </small>
          </span>
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.codexReview}
            onChange={(e) => onSettingsChange({ codexReview: e.target.checked }).catch(() => undefined)}
          />
          <span>
            Codex double-checks Claude
            <small>
              After Claude changes code, Codex reviews it for bugs and security problems, and Claude fixes
              anything real before it's done. Adds about a minute to bigger requests; quick edits skip it, and
              so does a nearly used-up Codex plan.
            </small>
          </span>
        </label>
      </section>

      <section className="settings-section">
        <div className="settings-section-header">
          <h3>Themes</h3>
          <button onClick={() => window.vibe.themes.openFolder()}>Open themes folder</button>
        </div>

        <div className="theme-grid">
          {themes.map((theme) => (
            <div
              key={theme.id}
              className={`theme-card${settings.themeId === theme.id ? ' active' : ''}`}
              style={{
                background: `${theme.vars['bg-image']}, ${theme.vars.bg}`,
                color: theme.vars.text,
                fontFamily: theme.vars.font
              }}
            >
              <div className="theme-card-name">{theme.name}</div>
              <div className="theme-swatches">
                {SWATCH_VARS.map((v) => (
                  <span key={v} style={{ background: theme.vars[v] }} />
                ))}
              </div>
              {theme.description && <p className="theme-card-desc">{theme.description}</p>}
              <div className="theme-card-actions">
                <span className="theme-source">{theme.source === 'built-in' ? 'Built-in' : theme.source === 'generated' ? 'Generated' : 'Extension'}</span>
                {settings.themeId === theme.id ? (
                  <span className="theme-applied">Applied</span>
                ) : (
                  <button onClick={() => onSettingsChange({ themeId: theme.id }).catch(() => undefined)}>
                    Apply
                  </button>
                )}
                {theme.source !== 'built-in' && <button onClick={() => handleDelete(theme)}>Delete</button>}
              </div>
            </div>
          ))}
        </div>

        <div className="theme-generate">
          <h4>Generate a theme</h4>
          <p className="memory-hint">
            Describe a vibe and Claude will design a theme for it. It's saved as a theme extension you can reuse.
          </p>
          <div className="memory-add-row">
            <input
              value={themePrompt}
              onChange={(e) => setThemePrompt(e.target.value)}
              placeholder="e.g. cozy Studio Ghibli forest at dusk, or 90s cyberpunk terminal"
              disabled={generating}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleGenerate()
              }}
            />
            <button onClick={handleGenerate} disabled={generating || !themePrompt.trim()}>
              {generating ? 'Designing…' : 'Generate'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

export default SettingsView
