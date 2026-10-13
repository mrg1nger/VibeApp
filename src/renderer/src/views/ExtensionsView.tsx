import { useCallback, useEffect, useState } from 'react'
import type { ExtensionCatalogItem, ExtensionInfo } from '@shared/types'

interface ExtensionsViewProps {
  onError: (message: string) => void
}

interface Listing {
  installed: ExtensionInfo[]
  catalog: ExtensionCatalogItem[]
  nodeAvailable: boolean
}

/** Splits "a b 'c d'" style text into arguments (quotes keep spaces together). */
function splitArgs(text: string): string[] {
  return (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^["']|["']$/g, ''))
}

function ExtensionsView({ onError }: ExtensionsViewProps) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Keys being filled in for a catalog item before it's added.
  const [pending, setPending] = useState<{ item: ExtensionCatalogItem; env: Record<string, string> } | null>(null)
  const [custom, setCustom] = useState({ name: '', command: '', args: '', instructions: '', env: '' })
  const [showCustom, setShowCustom] = useState(false)
  // Keys typed in for installed extensions that are waiting for them.
  const [keyInputs, setKeyInputs] = useState<Record<string, Record<string, string>>>({})

  const reload = useCallback(async () => {
    try {
      setListing(await window.vibe.extensions.list())
    } catch (err) {
      onError(`Couldn't load extensions: ${(err as Error).message}`)
    }
  }, [onError])

  useEffect(() => {
    reload()
  }, [reload])

  const run = useCallback(
    async (id: string, work: () => Promise<unknown>) => {
      setBusyId(id)
      try {
        await work()
        await reload()
      } catch (err) {
        onError((err as Error).message)
      } finally {
        setBusyId(null)
      }
    },
    [reload, onError]
  )

  const install = (item: ExtensionCatalogItem, env: Record<string, string>): Promise<void> =>
    run(item.id, async () => {
      await window.vibe.extensions.add({
        name: item.name,
        description: item.description,
        command: item.command,
        args: item.args,
        env,
        instructions: item.instructions,
        catalogId: item.id
      })
      setPending(null)
    })

  const addCustom = (): Promise<void> =>
    run('custom', async () => {
      const env: Record<string, string> = {}
      for (const line of custom.env.split('\n')) {
        const at = line.indexOf('=')
        if (at > 0) env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
      }
      await window.vibe.extensions.add({
        name: custom.name,
        command: custom.command,
        args: splitArgs(custom.args),
        env,
        instructions: custom.instructions
      })
      setCustom({ name: '', command: '', args: '', instructions: '', env: '' })
      setShowCustom(false)
    })

  if (!listing) return <div className="settings-view"><p className="review-muted">Loading…</p></div>

  const installedCatalogIds = new Set(listing.installed.map((e) => e.catalogId).filter(Boolean))
  const available = listing.catalog.filter((c) => !installedCatalogIds.has(c.id))

  return (
    <div className="settings-view">
      <section className="settings-section">
        <h3>Extensions</h3>
        <p className="review-muted">
          Extra tools for Claude and Codex, installed once and available in every project. Switch one off to
          stop both agents using it; changes apply to the next message.
        </p>
        {!listing.nodeAvailable && (
          <p className="chat-error">
            These tools need Node.js, which doesn't seem to be installed. Install it from nodejs.org, then
            come back.
          </p>
        )}
      </section>

      <section className="settings-section">
        <h3>Installed</h3>
        {listing.installed.length === 0 && <p className="review-muted">Nothing installed yet. Pick something below.</p>}
        {listing.installed.map((ext) => (
          <div key={ext.id} className="extension-row">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={ext.enabled}
                disabled={busyId === ext.id}
                onChange={(e) => run(ext.id, () => window.vibe.extensions.setEnabled(ext.id, e.target.checked))}
              />
              <span>
                {ext.name}
                <small>
                  {ext.description || `${ext.command} ${ext.args.join(' ')}`}
                  {ext.envNames.length > 0 && ` · keys: ${ext.envNames.join(', ')}`}
                </small>
              </span>
            </label>
            {ext.needsKeys.length > 0 && (
              <div className="extension-form">
                <span className="review-muted">Switched off until you add {ext.needsKeys.length === 1 ? 'this key' : 'these keys'}:</span>
                {ext.needsKeys.map((name) => (
                  <label key={name} className="settings-field">
                    {name}
                    <input
                      type="password"
                      value={keyInputs[ext.id]?.[name] ?? ''}
                      onChange={(e) =>
                        setKeyInputs({ ...keyInputs, [ext.id]: { ...keyInputs[ext.id], [name]: e.target.value } })
                      }
                    />
                  </label>
                ))}
                <button
                  disabled={busyId === ext.id}
                  onClick={() =>
                    run(ext.id, async () => {
                      await window.vibe.extensions.setEnv(ext.id, keyInputs[ext.id] ?? {})
                      setKeyInputs({ ...keyInputs, [ext.id]: {} })
                    })
                  }
                >
                  Save keys
                </button>
              </div>
            )}
            <button
              className="chat-inline-action"
              disabled={busyId === ext.id}
              onClick={() => {
                if (window.confirm(`Remove "${ext.name}"?`)) run(ext.id, () => window.vibe.extensions.remove(ext.id))
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </section>

      <section className="settings-section">
        <h3>Add one</h3>
        {available.map((item) => (
          <div key={item.id} className="extension-row">
            <span>
              {item.name}
              <small className="review-muted" style={{ display: 'block' }}>
                {item.description}
              </small>
            </span>
            <button
              disabled={busyId === item.id || !listing.nodeAvailable}
              onClick={() => (item.envNeeded.length ? setPending({ item, env: {} }) : install(item, {}))}
            >
              Install
            </button>
          </div>
        ))}
        {available.length === 0 && <p className="review-muted">You've installed everything in the list.</p>}

        {pending && (
          <div className="extension-form">
            <strong>{pending.item.name}</strong>
            {pending.item.envNeeded.map((need) => (
              <label key={need.name} className="settings-field">
                {need.label}
                <input
                  type="password"
                  value={pending.env[need.name] ?? ''}
                  onChange={(e) => setPending({ ...pending, env: { ...pending.env, [need.name]: e.target.value } })}
                />
              </label>
            ))}
            <div>
              <button onClick={() => install(pending.item, pending.env)}>Install</button>{' '}
              <button className="chat-inline-action" onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <p>
          <button className="chat-inline-action" onClick={() => setShowCustom((s) => !s)}>
            {showCustom ? 'Hide custom tool' : 'Add your own…'}
          </button>
        </p>
        {showCustom && (
          <div className="extension-form">
            <p className="review-muted">
              For a tool server you know how to run (an "MCP server"). Anything you add runs on this computer
              with your permissions, so only add ones you trust.
            </p>
            <label className="settings-field">
              Name
              <input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
            </label>
            <label className="settings-field">
              Program
              <input
                placeholder="npx"
                value={custom.command}
                onChange={(e) => setCustom({ ...custom, command: e.target.value })}
              />
            </label>
            <label className="settings-field">
              Arguments
              <input
                placeholder="-y some-mcp-server"
                value={custom.args}
                onChange={(e) => setCustom({ ...custom, args: e.target.value })}
              />
            </label>
            <label className="settings-field">
              Keys it needs (one per line, NAME=value)
              <textarea
                rows={2}
                value={custom.env}
                onChange={(e) => setCustom({ ...custom, env: e.target.value })}
              />
            </label>
            <label className="settings-field">
              When should the agents use it? (optional)
              <textarea
                rows={2}
                value={custom.instructions}
                onChange={(e) => setCustom({ ...custom, instructions: e.target.value })}
              />
            </label>
            <button disabled={busyId === 'custom' || !custom.name.trim() || !custom.command.trim()} onClick={addCustom}>
              Add
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

export default ExtensionsView
