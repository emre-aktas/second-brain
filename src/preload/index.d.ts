import type { ApiChannel, EventChannel } from '../shared/ipc'

declare global {
  interface Window {
    brain: {
      invoke(channel: ApiChannel, payload?: unknown): Promise<unknown>
      on(channel: EventChannel, listener: (payload: unknown) => void): () => void
      platform: string
      versions: { electron: string; chrome: string; node: string }
    }
  }
}

export {}
