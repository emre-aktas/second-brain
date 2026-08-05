/**
 * Accelerator parsing for tool shortcuts.
 *
 * The agent writes what a person would write — "ctrl + shift + t" — and Electron
 * wants "CommandOrControl+Shift+T". Normalising here rather than at the call site
 * means a shortcut the agent invents is accepted or rejected with a clear reason,
 * instead of silently failing to register.
 */

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'CommandOrControl',
  control: 'CommandOrControl',
  cmd: 'CommandOrControl',
  command: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  commandorcontrol: 'CommandOrControl',
  meta: 'Super',
  win: 'Super',
  super: 'Super',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift'
}

const NAMED_KEYS = new Set([
  'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down',
  'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Plus', 'Minus', 'Comma', 'Period', 'Slash', 'Backslash'
])

export interface HotkeyResult {
  ok: boolean
  accelerator?: string
  error?: string
}

export function normaliseHotkey(input: string): HotkeyResult {
  const raw = input.trim()
  if (!raw) return { ok: false, error: 'empty' }

  const parts = raw
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length < 2) {
    return {
      ok: false,
      error: 'a global shortcut needs at least one modifier and a key, e.g. Ctrl+Shift+T'
    }
  }

  const modifiers: string[] = []
  let key: string | null = null

  for (const part of parts) {
    const alias = MODIFIER_ALIASES[part.toLowerCase().replace(/\s+/g, '')]
    if (alias) {
      if (!modifiers.includes(alias)) modifiers.push(alias)
      continue
    }

    if (key !== null) {
      return { ok: false, error: `"${raw}" has more than one non-modifier key` }
    }

    if (part.length === 1 && /[a-z0-9]/i.test(part)) {
      key = part.toUpperCase()
      continue
    }

    const named = [...NAMED_KEYS].find((candidate) => candidate.toLowerCase() === part.toLowerCase())
    if (named) {
      key = named
      continue
    }

    return { ok: false, error: `"${part}" is not a key this app can bind` }
  }

  if (!key) return { ok: false, error: `"${raw}" has no key, only modifiers` }
  if (modifiers.length === 0) {
    return { ok: false, error: 'a global shortcut needs at least one modifier' }
  }

  // Stable modifier order so two spellings of the same combination compare equal.
  const order = ['CommandOrControl', 'Alt', 'Shift', 'Super']
  modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b))

  return { ok: true, accelerator: [...modifiers, key].join('+') }
}

/** Readable form for the UI: "Ctrl + Shift + T". */
export function formatHotkey(accelerator: string, platform = 'win32'): string {
  return accelerator
    .split('+')
    .map((part) =>
      part === 'CommandOrControl' ? (platform === 'darwin' ? '⌘' : 'Ctrl') : part === 'Super' ? 'Win' : part
    )
    .join(' + ')
}
