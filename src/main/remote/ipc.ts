import { ipc } from './bus'
import { revokeAll, revokeDevice, rotatePairingCode } from './auth'
import { applyRemoteSettings, disconnectDevice, previewUrlFor, remoteStatus } from './server'

/** Remote access actions for the desktop Settings screen (remote devices can only ask for preview addresses). */
export function registerRemoteHandlers(): void {
  ipc.handle('vibe:remote:status', () => remoteStatus())
  ipc.handle('vibe:remote:apply', async () => {
    await applyRemoteSettings()
    return remoteStatus()
  })
  ipc.handle('vibe:remote:rotateCode', () => {
    rotatePairingCode()
    return remoteStatus()
  })
  ipc.handle('vibe:remote:revoke', (_event, id: string) => {
    revokeDevice(id)
    disconnectDevice(id)
    return remoteStatus()
  })
  ipc.handle('vibe:remote:revokeAll', () => {
    revokeAll()
    disconnectDevice()
    return remoteStatus()
  })
  ipc.handle('vibe:remote:previewUrl', (_event, projectId: string) => previewUrlFor(projectId))
}
