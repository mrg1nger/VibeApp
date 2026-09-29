import { app, nativeImage } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ImageAttachment } from '@shared/types'

// Claude's image limits: 5 MB each, and anything past ~1568 px on the long
// side gets scaled down server-side anyway.
const MAX_API_BYTES = 3.75 * 1024 * 1024 // base64 adds a third; stay under 5 MB encoded
const MAX_EDGE = 1568
const MAX_IMAGES = 10
const THUMB_EDGE = 160
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

export interface PreparedImage {
  /** Content block for Claude. */
  block: { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
  /** Where the untouched original was saved (so Claude can use it as a file). */
  savedPath: string
  /** Small data: URL for the chat bubble and history. */
  thumbnail: string
}

function attachmentsDir(projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('Invalid project id.')
  const dir = join(app.getPath('userData'), 'attachments', projectId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Saves each pasted image and gets it ready for Claude: big screenshots are
 * scaled down (the saved original is left alone), and a thumbnail is made
 * for the chat.
 */
export function prepareImages(projectId: string, images: ImageAttachment[]): PreparedImage[] {
  if (images.length > MAX_IMAGES) throw new Error(`You can attach up to ${MAX_IMAGES} images at once.`)
  const dir = attachmentsDir(projectId)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return images.map((image, i) => {
    const ext = TYPES[image.mediaType]
    if (!ext) throw new Error(`${image.name || 'That file'} isn't a supported image (PNG, JPEG, GIF or WebP).`)
    const original = Buffer.from(image.data, 'base64')
    const safeName = (image.name || `image-${i + 1}`).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40)
    const savedPath = join(dir, `${stamp}-${i + 1}-${safeName}.${ext}`)
    writeFileSync(savedPath, original)

    // nativeImage decodes PNG and JPEG; GIF/WebP pass through as-is.
    const decoded = ext === 'png' || ext === 'jpg' ? nativeImage.createFromBuffer(original) : null
    let mediaType = image.mediaType as ImageMediaType
    let data = image.data
    if (decoded && !decoded.isEmpty()) {
      const { width, height } = decoded.getSize()
      if (Math.max(width, height) > MAX_EDGE || original.length > MAX_API_BYTES) {
        const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
        const resized = decoded.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' })
        const png = ext === 'png' ? resized.toPNG() : null
        const out = png && png.length <= MAX_API_BYTES ? png : resized.toJPEG(88)
        mediaType = out === png ? 'image/png' : 'image/jpeg'
        data = out.toString('base64')
      }
    } else if (original.length > MAX_API_BYTES) {
      throw new Error(`${image.name || 'That image'} is too large to send (limit about 3.7 MB for GIF/WebP).`)
    }

    let thumbnail = ''
    if (decoded && !decoded.isEmpty()) {
      const { width, height } = decoded.getSize()
      const scale = Math.min(1, THUMB_EDGE / Math.max(width, height))
      const thumb = decoded.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
      thumbnail = `data:image/png;base64,${thumb.toPNG().toString('base64')}`
    } else if (original.length <= 300 * 1024) {
      thumbnail = `data:${image.mediaType};base64,${image.data}`
    }

    return { block: { type: 'image', source: { type: 'base64', media_type: mediaType, data } }, savedPath, thumbnail }
  })
}

/** Tells Claude where the originals are, in case the user wants them used as files. */
export function imagesNote(prepared: PreparedImage[]): string {
  const list = prepared.map((p) => `- ${p.savedPath}`).join('\n')
  return `[VibeApp note: the user attached ${prepared.length === 1 ? 'an image' : `${prepared.length} images`} to this message. The original ${prepared.length === 1 ? 'file is' : 'files are'} saved at:\n${list}\nIf they want an image used in the project (as a sprite, icon, background, etc.), copy the original from there into the project rather than recreating it.]`
}
