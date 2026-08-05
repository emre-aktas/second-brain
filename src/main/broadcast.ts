import { BrowserWindow, type WebContents } from 'electron'
import { createLogger } from './logger'

const log = createLogger('broadcast')

/**
 * Fans an event out to every window this app owns.
 *
 * This exists because it was originally one line targeting the main window, and
 * that was the reason a tool opened in its own window looked broken: the run
 * started, the agent worked, and none of `agent:event`, `tools:stateChanged` or
 * `chat:question` ever arrived there. The spinner spun forever, the agent's edits
 * never appeared, and a question from `ask_user` blocked the turn until it timed
 * out — all of it invisible, because the main window behaved perfectly.
 *
 * Every window in this app runs our renderer behind our preload, so "every window"
 * is the correct audience for a state change. A window that does not care ignores
 * the channel.
 */
export class Broadcaster {
  /** Events for a window that is still loading, so nothing is lost on open. */
  private queues = new Map<number, { channel: string; payload: unknown }[]>()

  send(channel: string, payload?: unknown): void {
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
    if (windows.length === 0) return

    for (const win of windows) this.sendTo(win.webContents, channel, payload)
  }

  private sendTo(contents: WebContents, channel: string, payload: unknown): void {
    if (contents.isDestroyed()) return

    // A window opened mid-conversation would otherwise miss everything up to its
    // first paint — including the result of the run that opened it.
    if (contents.isLoading()) {
      const queued = this.queues.get(contents.id)
      if (queued) {
        queued.push({ channel, payload })
        return
      }

      const pending = [{ channel, payload }]
      this.queues.set(contents.id, pending)
      contents.once('did-finish-load', () => {
        this.queues.delete(contents.id)
        if (contents.isDestroyed()) return
        for (const event of pending) contents.send(event.channel, event.payload)
      })
      contents.once('destroyed', () => this.queues.delete(contents.id))
      return
    }

    try {
      contents.send(channel, payload)
    } catch (err) {
      log.warn(`could not deliver ${channel} to window ${contents.id}`, err)
    }
  }

  /** How many windows an event would reach right now. For diagnostics. */
  audience(): number {
    return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length
  }
}
