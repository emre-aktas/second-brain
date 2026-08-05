import type { CSSProperties } from 'react'
import { CONTROLS_CLEARANCE, controlsSide } from '@shared/window-chrome'

/**
 * Room for the native window controls, on whichever side this OS draws them.
 *
 * Every window here hides the native title bar and draws its own strip, so each one
 * has to keep its contents out from under the buttons the OS still paints on top.
 * The side is not the same everywhere: Windows and Linux put them on the right,
 * macOS on the left. Hardcoding a right-hand margin left the window title sitting
 * underneath the traffic lights on macOS, and the buttons it was meant to protect
 * stranded 140px from the edge.
 *
 * Returned as inline style rather than a Tailwind class because the value has to
 * come from the shared constant — one number, used by the main process to place the
 * lights and by the renderer to leave room for them.
 */
export function controlsGap(): CSSProperties {
  const side = controlsSide(window.brain.platform)
  const gap = `${CONTROLS_CLEARANCE[side]}px`
  return side === 'left' ? { marginLeft: gap } : { marginRight: gap }
}

/** True on macOS, for the few places where the platform changes the wording. */
export function isMac(): boolean {
  return window.brain.platform === 'darwin'
}

/** The modifier key this platform calls the primary one, for display only. */
export function modifierLabel(): string {
  return isMac() ? '⌘' : 'Ctrl'
}
