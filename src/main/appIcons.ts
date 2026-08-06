import { app, nativeImage } from 'electron'
import { join } from 'node:path'
import { createLogger } from './logger'

const log = createLogger('icons')

/**
 * Loading one of the app's own icon files at runtime.
 *
 * Shared by the tray and by the unread badge, which need the same four answers to "where does
 * this file live" — a packaged app, `npm run dev`, and a probe that bundles main into a temp
 * directory all put it somewhere different, and an icon that silently fails to load is
 * either a window the user cannot get back or a badge that never appears.
 *
 * Cached, because the badge is applied every time the inbox changes and reading a PNG off
 * disk on the main thread is not free.
 */
const cache = new Map<string, Electron.NativeImage>()

export function appImage(file: string): Electron.NativeImage {
  const hit = cache.get(file)
  if (hit) return hit

  const candidates = app.isPackaged
    ? [join(process.resourcesPath, file), join(process.resourcesPath, 'app', 'build', file)]
    : [
        join(app.getAppPath(), 'build', file),
        join(process.cwd(), 'build', file),
        join(__dirname, '..', '..', 'build', file)
      ]

  for (const path of candidates) {
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) continue
    cache.set(file, image)
    return image
  }

  log.warn(`${file} not found; looked in ${candidates.join(', ')}`)
  const empty = nativeImage.createEmpty()
  cache.set(file, empty)
  return empty
}
