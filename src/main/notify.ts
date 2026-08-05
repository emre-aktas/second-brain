import { app, BrowserWindow, Notification } from 'electron'
import type { BrainCore } from './core'
import type { AgentManager } from './agent/manager'
import type { AgentEvent } from '@shared/types'
import type { PendingQuestion } from '@shared/ipc'
import { createLogger } from './logger'

const log = createLogger('notify')

/**
 * Must be byte-identical to `appId` in electron-builder.yml.
 *
 * Windows attributes a toast to the shortcut's identity rather than the process's, and
 * a mismatch does not warn — the notification simply never appears.
 */
const APP_USER_MODEL_ID = 'io.github.emreaktas.secondbrain'

/** Trim a reply down to something that fits in a notification without a scrollbar. */
function preview(text: string, limit = 180): string {
  const flat = text
    // Markdown is written for the chat panel, not for a system toast, and the raw
    // syntax reads worse than the prose it decorates.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|__|`|\*|_/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/**
 * Desktop notifications.
 *
 * The rule that shapes all of this: never tell someone something they are already
 * looking at. A notification for a reply that has just appeared on screen is pure
 * noise, and enough of that and the user turns the whole feature off — so every path
 * here checks focus first.
 */
export class Notifier {
  private disposers: (() => void)[] = []

  constructor(
    private core: BrainCore,
    private agent: AgentManager,
    /** Brings the app forward and opens a chat. */
    private reveal: (sessionId: string | null) => void
  ) {}

  start(): void {
    // Windows shows the shortcut's identity on a toast, not the process's, and
    // without this it either falls back to "electron.app.Electron" or drops the
    // notification. electron-builder installs a shortcut with this id.
    if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)

    if (!Notification.isSupported()) {
      log.info('the desktop does not support notifications; none will be sent')
      return
    }

    this.disposers.push(this.agent.onAgentEvent((event) => this.onAgentEvent(event)))

    // Questions have their own channel because a turn blocks on one, so they are
    // hooked separately rather than arriving as an agent event.
    const previous = this.agent.questions.onAsk
    this.agent.questions.onAsk = (question) => {
      previous?.(question)
      this.onQuestion(question)
    }
    this.disposers.push(() => {
      this.agent.questions.onAsk = previous
    })
  }

  stop(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }

  /* --------------------------------------------------------------- deciding */

  /**
   * True when the user cannot already see what we are about to tell them.
   *
   * Any window counts, not just the main one: a tool popped out into its own window
   * is still this app, and interrupting someone working in it to say the app did
   * something is the same mistake.
   */
  private unattended(): boolean {
    return !BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isFocused())
  }

  /**
   * A question is the one thing worth surfacing even with the app in front of them.
   *
   * The turn is stopped until it is answered, and the chat that asked may not be the
   * one on screen — which is exactly the case for a task running on its own clock.
   */
  private onQuestion(question: PendingQuestion): void {
    const settings = this.core.settings.notifications
    if (!settings.enabled || !settings.onQuestion) return

    const task = this.core.tasks.bySession(question.sessionId)
    this.send({
      title: task ? `${task.name} is asking` : 'The agent is asking',
      body: preview(question.question, 140),
      sessionId: question.sessionId,
      // Silent when they are right here: the card is already on screen, so this is a
      // marker in the notification centre rather than an interruption.
      silent: !this.unattended()
    })
  }

  private onAgentEvent(event: AgentEvent): void {
    const settings = this.core.settings.notifications
    if (!settings.enabled) return

    if (event.type !== 'result') return

    const text = (event.text ?? '').trim()
    if (!text) return

    const task = this.core.tasks.bySession(event.sessionId)

    if (task) {
      if (!settings.onProactive) return
      // The heartbeat is told to say this exact phrase when it has nothing worth
      // raising, and it is meant to be the usual answer. Notifying about it would
      // turn a deliberately quiet feature into an hourly interruption.
      if (/^nothing to report\.?$/i.test(text)) return

      this.send({
        title: task.name,
        body: preview(text),
        sessionId: event.sessionId,
        silent: false
      })
      return
    }

    // An ordinary chat reply. Only worth a toast if they walked away from it.
    if (!settings.onReply || !this.unattended()) return

    this.send({
      title: 'Second Brain replied',
      body: preview(text),
      sessionId: event.sessionId,
      silent: false
    })
  }

  /* ---------------------------------------------------------------- sending */

  private send(input: {
    title: string
    body: string
    sessionId: string | null
    silent: boolean
  }): void {
    if (!Notification.isSupported()) return

    try {
      const notification = new Notification({
        title: input.title,
        body: input.body,
        silent: input.silent
      })

      // The click has to land somewhere useful. A toast that only raises the window
      // leaves the user hunting for what it was about — especially for a task, whose
      // chat is archived and not in the recent list.
      notification.on('click', () => this.reveal(input.sessionId))
      notification.show()
    } catch (err) {
      log.warn('could not show a notification', err)
    }
  }
}
