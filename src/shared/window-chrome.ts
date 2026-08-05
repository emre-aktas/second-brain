/**
 * Where the native window controls sit, and how much room to leave them.
 *
 * Every window in this app hides the native title bar and draws its own strip, so
 * each one has to leave a hole for the controls the OS still draws on top. Windows
 * and Linux put minimise/maximise/close on the right; macOS puts the three traffic
 * lights on the left. Reserving space on the right on macOS did both wrong at once:
 * the buttons sat marooned 140px from the edge, and the window title underneath the
 * traffic lights.
 *
 * Shared between main and renderer on purpose. Main needs the inset to place the
 * traffic lights, the renderer needs the same number to pad its header, and two
 * copies of it would drift.
 */

export type ControlsSide = 'left' | 'right'

/** Which edge the OS draws its window controls on. */
export function controlsSide(platform: string): ControlsSide {
  return platform === 'darwin' ? 'left' : 'right'
}

/**
 * Clearance the controls need, in CSS pixels.
 *
 * The traffic lights are a 52px cluster; 78 leaves the breathing room macOS apps
 * conventionally give them. Windows' three buttons are wider and 140 is what the
 * app already used and looked right at.
 */
export const CONTROLS_CLEARANCE: Record<ControlsSide, number> = {
  left: 78,
  right: 140
}

/**
 * Where to put the traffic lights so they sit centred in a title strip of `height`.
 *
 * Electron positions the cluster by its top-left corner and the buttons are 12px
 * tall, so centring is the obvious arithmetic — but left at the default the lights
 * ride high against a strip this short, which reads as a misaligned window.
 */
export function trafficLightPosition(height: number): { x: number; y: number } {
  return { x: 14, y: Math.max(0, Math.round((height - 12) / 2)) }
}
