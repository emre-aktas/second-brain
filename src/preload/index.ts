import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { API_CHANNELS, EVENT_CHANNELS, type ApiChannel, type EventChannel } from '@shared/ipc'

const invokable = new Set<string>(API_CHANNELS)
const subscribable = new Set<string>(EVENT_CHANNELS)

/**
 * The only surface the renderer gets.
 *
 * The renderer runs sandboxed with context isolation, so it has no Node access
 * and no ipcRenderer of its own. Both channel names are checked against the
 * shared allowlists rather than forwarded blindly, which keeps the boundary
 * explicit even though every caller is our own code.
 */
const api = {
  invoke(channel: ApiChannel, payload?: unknown): Promise<unknown> {
    if (!invokable.has(channel)) {
      return Promise.reject(new Error(`"${channel}" is not an allowed channel`))
    }
    return ipcRenderer.invoke(channel, payload)
  },

  on(channel: EventChannel, listener: (payload: unknown) => void): () => void {
    if (!subscribable.has(channel)) {
      throw new Error(`"${channel}" is not a subscribable event`)
    }

    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },

  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
}

contextBridge.exposeInMainWorld('brain', api)

export type PreloadApi = typeof api
