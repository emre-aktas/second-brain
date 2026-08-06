import { app, type BrowserWindow } from 'electron'
import { appImage } from './appIcons'
import { createLogger } from './logger'

const log = createLogger('badge')

/**
 * The unread mark on the app icon.
 *
 * The inbox already exists and the chat header already shows a count; what was missing is any
 * sign of it when the app is not the window you are looking at. That is exactly when it
 * matters — the whole reason the inbox exists is that a desktop notification is not a reliable
 * channel, so there has to be something still saying "there is something here" afterwards.
 *
 * A drawn badge rather than the platform's own overlay, and that is a deliberate trade.
 * Windows' `setOverlayIcon` puts its image at the *bottom* right and the position is not
 * controllable; a badge belongs top-right, where every other application puts one. Swapping
 * the window icon for a variant with the dot already in it is the only way to choose. The cost
 * is two more generated assets; see `scripts/make-icon.mjs`.
 *
 * macOS has no window icon to swap, so there it is the Dock badge, which is the native answer.
 */
export function applyUnreadBadge(window: BrowserWindow | null, unread: number): void {
  const has = unread > 0

  if (process.platform === 'darwin') {
    // A dot rather than a number. The count is in the app; what the Dock has to carry is
    // whether there is anything at all, and a growing number in the corner reads as a backlog
    // to clear rather than as something to look at.
    app.dock?.setBadge(has ? '•' : '')
    return
  }

  if (!window || window.isDestroyed()) return

  const image = appImage(has ? 'icon-unread.png' : 'icon.png')
  if (image.isEmpty()) {
    // Without the artwork there is nothing to swap to, and setting an empty image would leave
    // the window with no icon at all — worse than no badge.
    log.debug('no icon to badge with')
    return
  }

  window.setIcon(image)
}
