import { globalShortcut } from 'electron'
import type { SavedTool } from '@shared/types'
import { createLogger } from './logger'

const log = createLogger('shortcuts')

export interface ShortcutState {
  toolId: string
  accelerator: string
  /** False when the OS or another app already owns this combination. */
  registered: boolean
}

/**
 * Global shortcuts that summon a tool from anywhere.
 *
 * This is what makes a translator usable mid-sentence in another application:
 * press the key, the tool is in front of you with the cursor in its input. The
 * shortcut belongs to the tool rather than the app, so the agent can assign one
 * when it builds something worth reaching for.
 *
 * Registration can fail — another application may already hold the combination —
 * so the outcome is recorded per tool and surfaced rather than swallowed.
 */
export class ShortcutManager {
  private states = new Map<string, ShortcutState>()

  constructor(private activate: (toolId: string) => void) {}

  /** Rebind everything from the current set of tools. */
  sync(tools: SavedTool[]): ShortcutState[] {
    this.unregisterAll()

    for (const tool of tools) {
      if (!tool.hotkey) continue

      // Two tools claiming one combination: first wins, and the second is
      // reported as unregistered so the UI can say why it does nothing.
      const taken = [...this.states.values()].some(
        (state) => state.accelerator === tool.hotkey && state.registered
      )

      if (taken) {
        this.states.set(tool.id, {
          toolId: tool.id,
          accelerator: tool.hotkey,
          registered: false
        })
        continue
      }

      let registered = false
      try {
        registered = globalShortcut.register(tool.hotkey, () => this.activate(tool.id))
      } catch (err) {
        log.warn(`could not register ${tool.hotkey} for ${tool.name}`, err)
      }

      if (!registered) {
        log.info(`${tool.hotkey} is unavailable — another application holds it`)
      }

      this.states.set(tool.id, { toolId: tool.id, accelerator: tool.hotkey, registered })
    }

    const active = [...this.states.values()].filter((state) => state.registered).length
    log.info(`${active} of ${this.states.size} tool shortcut(s) active`)

    return this.list()
  }

  list(): ShortcutState[] {
    return [...this.states.values()]
  }

  statusFor(toolId: string): ShortcutState | undefined {
    return this.states.get(toolId)
  }

  /** Check availability without keeping the binding. */
  isAvailable(accelerator: string): boolean {
    if (globalShortcut.isRegistered(accelerator)) return false

    try {
      const ok = globalShortcut.register(accelerator, () => {})
      if (ok) globalShortcut.unregister(accelerator)
      return ok
    } catch {
      return false
    }
  }

  unregisterAll(): void {
    for (const state of this.states.values()) {
      if (!state.registered) continue
      try {
        globalShortcut.unregister(state.accelerator)
      } catch {
        /* already gone */
      }
    }
    this.states.clear()
  }
}
