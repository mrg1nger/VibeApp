import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, BackupInfo } from '@shared/types'

interface BackupSettingsProps {
  settings: AppSettings
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>
  onError: (message: string) => void
}

const size = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`

const clean = (err: unknown): string => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Backups of VibeApp's own data: once a day, on demand, export, and restore. */
function BackupSettings({ settings, onSettingsChange, onError }: BackupSettingsProps) {
  const [status, setStatus] = useState<{ dir: string; defaultDir: string; backups: BackupInfo[] } | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [dir, setDir] = useState(settings.backupDir ?? '')
  const [exportTo, setExportTo] = useState('')
  const [restoreFrom, setRestoreFrom] = useState('')

  const reload = useCallback(() => {
    window.vibe.backup.status().then(setStatus).catch((err) => onError(clean(err)))
  }, [onError])
  useEffect(() => {
    reload()
  }, [reload, settings.backupLastAt])

  const act = async (what: string, work: () => Promise<unknown>): Promise<void> => {
    setWorking(what)
    try {
      await work()
      reload()
    } catch (err) {
      onError(clean(err))
    } finally {
      setWorking(null)
    }
  }

  const restore = (path: string, when: string): void => {
    if (
      !window.confirm(
        `Restore VibeApp's data from the backup of ${when}?\n\nYour memory, chats, notes, settings and secrets go back to how they were then. Your current data is backed up first, so you can undo this by restoring that. VibeApp restarts to finish.`
      )
    ) {
      return
    }
    void act('restore', () => window.vibe.backup.restore(path))
  }

  return (
    <>
      <label className="settings-toggle">
        <input type="checkbox" checked={settings.backupDaily} onChange={(e) => onSettingsChange({ backupDaily: e.target.checked }).catch(() => undefined)} />
        <span>
          Back up VibeApp's data every day
          <small>
            Memory, chat history, to-dos and notes, settings, secrets, deploy steps, extensions and themes: everything that isn't in
            your project's own files. Your code is in git; this is what would be lost with this computer's disk. The newest{' '}
            {settings.backupKeep} are kept.
          </small>
        </span>
      </label>
      <label className="settings-field">
        <span>Backup folder</span>
        <input
          value={dir}
          placeholder={status?.defaultDir ?? ''}
          onChange={(e) => setDir(e.target.value)}
          onBlur={() => dir.trim() !== (settings.backupDir ?? '') && onSettingsChange({ backupDir: dir.trim() || null }).catch(() => undefined)}
        />
        <small>A different drive, or a OneDrive or Dropbox folder, keeps them safe even if this disk fails. Leave empty for {status?.defaultDir}.</small>
      </label>
      <p className="review-muted">
        {settings.backupLastAt ? `Last backup: ${new Date(settings.backupLastAt).toLocaleString()}.` : 'No backup yet.'}
        {settings.backupLastError && <span className="chat-error"> The last try failed: {settings.backupLastError}</span>}
      </p>
      <div className="backup-actions">
        <button disabled={!!working} onClick={() => act('now', () => window.vibe.backup.now())}>
          {working === 'now' ? 'Backing up…' : 'Back up now'}
        </button>
      </div>

      {status && status.backups.length > 0 && (
        <details className="backup-list">
          <summary>
            {status.backups.length} backup{status.backups.length === 1 ? '' : 's'} in {status.dir}
          </summary>
          <ul>
            {status.backups.map((b) => {
              const when = new Date(b.createdAt).toLocaleString()
              return (
                <li key={b.path}>
                  <span>
                    {when} · {size(b.bytes)}
                    {b.reason === 'before restore' ? ' · made before a restore' : b.reason === 'manual' ? ' · made by hand' : ''}
                  </span>
                  <button className="chat-inline-action" disabled={!!working} onClick={() => restore(b.path, when)}>
                    Restore
                  </button>
                </li>
              )
            })}
          </ul>
        </details>
      )}

      <details className="backup-list">
        <summary>Move VibeApp to another computer (export / import)</summary>
        <p className="review-muted">
          Export makes a backup in any folder (a USB stick, say). On the other computer, install VibeApp, then restore from that
          folder here. Secrets and extension keys are locked to this Windows account, so on a new computer you'll need to enter them
          again; devices for Remote access pair again too.
        </p>
        <div className="backup-path-row">
          <input value={exportTo} placeholder="Folder to export to, e.g. E:\" onChange={(e) => setExportTo(e.target.value)} />
          <button disabled={!!working || !exportTo.trim()} onClick={() => act('export', () => window.vibe.backup.export(exportTo.trim()))}>
            {working === 'export' ? 'Exporting…' : 'Export'}
          </button>
        </div>
        <div className="backup-path-row">
          <input value={restoreFrom} placeholder="A backup folder to restore, e.g. E:\VibeApp backup 2026-10-26 …" onChange={(e) => setRestoreFrom(e.target.value)} />
          <button disabled={!!working || !restoreFrom.trim()} onClick={() => restore(restoreFrom.trim(), 'that folder')}>
            Restore
          </button>
        </div>
      </details>
    </>
  )
}

export default BackupSettings
