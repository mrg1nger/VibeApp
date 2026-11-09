import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, CodexModelList, ModelOption, ThemeDefinition, UsageSummaryRow } from '@shared/types'
import UsageReport from '../components/UsageReport'
import RemoteAccessSettings from '../components/RemoteAccessSettings'
import BackupSettings from '../components/BackupSettings'
import ScheduleSettings from '../components/ScheduleSettings'
import PhoneAlertSettings from '../components/PhoneAlertSettings'

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
  const [codexList, setCodexList] = useState<CodexModelList | null>(null)
  const [codexListError, setCodexListError] = useState(false)
  const [themePrompt, setThemePrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [usageRows, setUsageRows] = useState<UsageSummaryRow[] | null>(null)

  useEffect(() => {
    window.vibe.usage
      .summary(7)
      .then(setUsageRows)
      .catch(() => setUsageRows([]))
  }, [])

  useEffect(() => {
    window.vibe.models
      .claude()
      .then(setModels)
      .catch(() => setModelsError(true))
    window.vibe.models
      .codex()
      .then(setCodexList)
      .catch(() => setCodexListError(true))
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

  // Same for Codex; the efforts offered are the ones the model in use supports.
  const codexOptions =
    codexList && settings.codexModel && !codexList.models.some((m) => m.value === settings.codexModel)
      ? [...codexList.models, { value: settings.codexModel, displayName: settings.codexModel, description: '', efforts: [] }]
      : (codexList?.models ?? [])
  const codexInUse = codexOptions.find((m) => m.value === (settings.codexModel ?? codexList?.defaultModel))
  const effortOptions = codexInUse?.efforts.length
    ? codexInUse.efforts
    : ['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, description: '' }))
  const effortChoices =
    settings.codexEffort && !effortOptions.some((e) => e.value === settings.codexEffort)
      ? [...effortOptions, { value: settings.codexEffort, description: "(not listed for this model)" }]
      : effortOptions
  const defaultModelName = codexList?.defaultModel
    ? (codexOptions.find((m) => m.value === codexList.defaultModel)?.displayName ?? codexList.defaultModel)
    : undefined
  const defaultEffort = codexList?.defaultEffort ?? codexInUse?.defaultEffort

  return (
    <div className="settings-view">
      <h2>Settings</h2>
      <p className="settings-hint">VibeApp {__APP_VERSION__}</p>

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
          {codexListError ? (
            <>
              <input
                value={codexModel}
                onChange={(e) => setCodexModel(e.target.value)}
                onBlur={saveCodexModel}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveCodexModel()
                }}
                placeholder="Default (from your Codex config)"
              />
              <small>Couldn't load Codex's model list, so type a model name. Leave blank for Codex's default.</small>
            </>
          ) : (
            <select
              value={settings.codexModel ?? ''}
              onChange={(e) => {
                const value = e.target.value || null
                // An effort the new model doesn't support goes back to Codex's default.
                const efforts = codexOptions.find((m) => m.value === (value ?? codexList?.defaultModel))?.efforts
                const keepEffort = !settings.codexEffort || !efforts?.length || efforts.some((x) => x.value === settings.codexEffort)
                onSettingsChange(keepEffort ? { codexModel: value } : { codexModel: value, codexEffort: null }).catch(() => undefined)
              }}
              disabled={!codexList}
            >
              <option value="">Codex's default{defaultModelName ? ` (${defaultModelName})` : ''}</option>
              {codexOptions.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.displayName}
                  {m.description ? ` — ${m.description}` : ''}
                </option>
              ))}
            </select>
          )}
          {!codexList && !codexListError && <small>Loading models…</small>}
          <small>Used for hand-offs, reviews, and whenever Codex takes over.</small>
        </label>

        <label className="settings-field">
          <span>Codex thinking effort</span>
          <select
            value={settings.codexEffort ?? ''}
            onChange={(e) => onSettingsChange({ codexEffort: e.target.value || null }).catch(() => undefined)}
          >
            <option value="">Codex's default{defaultEffort ? ` (${defaultEffort})` : ''}</option>
            {effortChoices.map((e) => (
              <option key={e.value} value={e.value}>
                {e.value}
                {e.description ? ` — ${e.description}` : ''}
              </option>
            ))}
          </select>
          <small>Higher thinks harder: better on tricky work, but slower and uses more of your Codex plan.</small>
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
          <span>
            When Claude's plan limit is reached
            <small>
              Codex can take your request directly, so you keep working until Claude's window resets. Ask first
              shows a button instead; Off just reports the limit.
            </small>
          </span>
          <select
            value={settings.limitTakeover}
            onChange={(e) =>
              onSettingsChange({ limitTakeover: e.target.value as typeof settings.limitTakeover }).catch(() => undefined)
            }
          >
            <option value="auto">Switch to Codex automatically</option>
            <option value="ask">Ask me first</option>
            <option value="off">Do nothing</option>
          </select>
        </label>

        <label className="settings-toggle">
          <span>
            Big requests
            <small>
              When a request sent in Build looks big (several parts, or judged complex), VibeApp can ask whether to plan
              it first: Claude looks around and shows a plan to approve before anything changes. Small requests are never
              interrupted.
            </small>
          </span>
          <select
            value={settings.planBigRequests}
            onChange={(e) =>
              onSettingsChange({ planBigRequests: e.target.value as typeof settings.planBigRequests }).catch(() => undefined)
            }
          >
            <option value="ask">Ask me to plan first</option>
            <option value="always">Always plan them first</option>
            <option value="off">Just build</option>
          </select>
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.autoAsk}
            onChange={(e) => onSettingsChange({ autoAsk: e.target.checked }).catch(() => undefined)}
          />
          <span>
            Answer plain questions the cheap way
            <small>
              A message that is only a question ("which file handles X?", "how many realms are there?") is answered
              in Ask mode even when you're in Build, so it doesn't re-read the whole coding conversation. The reply
              has a button to send it to Build instead.
            </small>
          </span>
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.autoMemory}
            onChange={(e) => onSettingsChange({ autoMemory: e.target.checked }).catch(() => undefined)}
          />
          <span>
            Save memory automatically
            <small>
              After each request a quick Haiku pass decides what's worth remembering, so Claude and Codex don't
              each spend a step on it. Applies to new chats. Saved facts are labelled "Saved automatically" on
              the Memory screen.
            </small>
          </span>
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.autoCompact}
            onChange={(e) => onSettingsChange({ autoCompact: e.target.checked }).catch(() => undefined)}
          />
          <span>
            Compact long conversations automatically
            <small>
              A long conversation is re-read on every step. Once it passes the size below, VibeApp first saves the
              rules, procedures and project brief to memory, then has Claude summarise the conversation in place
              and carry on in the same session. Details can still be lost, so keep important rules in Memory.
              You can also compact from the chat at any time.
            </small>
          </span>
        </label>

        <label className="settings-toggle settings-subtoggle">
          <span>
            Compact at about
            <small>Lower saves more usage but summarises sooner.</small>
          </span>
          <select
            value={settings.rotateAtTokens}
            disabled={!settings.autoCompact}
            onChange={(e) => onSettingsChange({ rotateAtTokens: Number(e.target.value) }).catch(() => undefined)}
          >
            {[60_000, 90_000, 120_000, 160_000, 200_000].map((n) => (
              <option key={n} value={n}>
                {n / 1000}k tokens
              </option>
            ))}
          </select>
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.exportAgentsFile}
            onChange={(e) => onSettingsChange({ exportAgentsFile: e.target.checked }).catch(() => undefined)}
          />
          <span>
            Share key facts with other tools (AGENTS.md)
            <small>
              Off by default. Keeps a block of this project's key facts in an AGENTS.md file in the project
              folder, so other AI tools opened there see them too. If VibeApp creates the file it's added to
              .gitignore, so it isn't published with your code. Facts that look like secrets are left out.
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
        <h3>Running in the background</h3>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.trayMode}
            onChange={(e) => onSettingsChange({ trayMode: e.target.checked }).catch(() => undefined)}
          />
          <span>
            Keep running in the tray when the window is closed
            <small>
              Closing the window frees its memory, but VibeApp keeps working: requests carry on, and browsers and
              phones stay connected. Open it again, copy the pairing code or quit from the tray icon (bottom right of
              the taskbar). Windows notifications say when something is waiting for you.
            </small>
          </span>
        </label>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.startWithWindows}
            onChange={(e) => onSettingsChange({ startWithWindows: e.target.checked }).catch(() => undefined)}
          />
          <span>
            Start with Windows, in the tray
            <small>
              VibeApp starts when you sign in, with no window, ready for your browsers and phone. (Only for the
              installed app.)
            </small>
          </span>
        </label>
        {(settings.trayMode || settings.startWithWindows) && settings.remoteAccess === 'off' && (
          <p className="chat-error">
            Remote access is off, so with no window open the only way in is the tray icon. Turn it on below to use
            VibeApp from a browser or your phone.
          </p>
        )}
      </section>

      <section className="settings-section">
        <h3>Schedules</h3>
        <ScheduleSettings settings={settings} onSettingsChange={onSettingsChange} />
      </section>

      <section className="settings-section">
        <h3>Backups</h3>
        <BackupSettings settings={settings} onSettingsChange={onSettingsChange} onError={onError} />
      </section>

      <section className="settings-section">
        <h3>Phone alerts</h3>
        <PhoneAlertSettings settings={settings} onSettingsChange={onSettingsChange} onError={onError} />
      </section>

      <section className="settings-section">
        <h3>Remote access</h3>
        <RemoteAccessSettings settings={settings} onSettingsChange={onSettingsChange} onError={onError} />
      </section>

      <section className="settings-section">
        <h3>Where your usage goes (last 7 days)</h3>
        {usageRows === null ? (
          <p className="memory-hint">Loading…</p>
        ) : usageRows.length === 0 ? (
          <p className="memory-hint">Nothing recorded yet. Usage is logged as you work.</p>
        ) : (
          <table className="usage-table">
            <thead>
              <tr>
                <th>What</th>
                <th>Runs</th>
                <th title="Input processed fresh (not served from cache)">New</th>
                <th title="Input reused from the prompt cache (cheap)">Cached</th>
                <th>Written</th>
              </tr>
            </thead>
            <tbody>
              {usageRows.map((r) => (
                <tr key={r.kind}>
                  <td>{r.kind}</td>
                  <td>{r.runs}</td>
                  <td>{r.fresh.toLocaleString()}</td>
                  <td>{r.cached.toLocaleString()}</td>
                  <td>{r.output.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <small className="memory-hint">
          Token counts from VibeApp's own log. "request" is Claude working on what you asked; "route", "scribe",
          "tidy", "codemap" and "summary" are the small Haiku helpers; "handoff" and "review" are Codex.
        </small>
        <UsageReport />
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
