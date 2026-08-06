import { app, BrowserWindow, Notification } from 'electron'
import { tmpdir } from 'node:os'
import type { BrainCore } from './core'
import type { AgentManager } from './agent/manager'
import type { AgentEvent, InboxKind } from '@shared/types'
import type { PendingQuestion } from '@shared/ipc'
import { createLogger } from './logger'

const log = createLogger('notify')

/**
 * The Windows toast identity for this build channel.
 *
 * A toast is not delivered to a process, it is delivered to an *identity*: Windows looks
 * up the AppUserModelID, finds the COM activator class registered for it, and starts
 * whatever `LocalServer32` names. If no Start Menu shortcut carrying that identity points
 * at the executable that is actually running, the click is resolved to something else — or
 * to a path that no longer exists — and the app never hears about it. That is why clicking
 * a notification did nothing, and it is a shell-level failure that no amount of in-app
 * code can fix.
 *
 * Two things follow. The activator CLSID is pinned rather than left for Electron to
 * generate, so the shortcut, the registry and the running process agree across launches.
 * And each channel gets its own identity: a dev run, a portable exe and an installed copy
 * are three different executables, and letting them share one identity means whichever
 * ran last owns it.
 *
 * The installed value must stay byte-identical to `appId` in electron-builder.yml — the
 * installer stamps that onto its shortcut (build/installer.nsh), and changing it here
 * would orphan every installed copy's toasts.
 */
type ToastChannel = 'installed' | 'portable' | 'dev'

interface ToastIdentity {
  aumid: string
  clsid: string
}

const TOAST_IDENTITY: Record<ToastChannel, ToastIdentity> = {
  installed: {
    aumid: 'io.github.emreaktas.secondbrain',
    clsid: '{6E1B3A64-8C4F-4E2A-9D71-2F0B5C8A7E31}'
  },
  portable: {
    aumid: 'io.github.emreaktas.secondbrain.portable',
    clsid: '{6E1B3A64-8C4F-4E2A-9D71-2F0B5C8A7E32}'
  },
  dev: {
    aumid: 'io.github.emreaktas.secondbrain.dev',
    clsid: '{6E1B3A64-8C4F-4E2A-9D71-2F0B5C8A7E33}'
  }
}

/**
 * Which of the three this process is.
 *
 * Pure and exported so it can be tested without an Electron app object — the probe for
 * this cannot import anything that touches `app` at module scope.
 */
export function toastChannelFor(input: {
  packaged: boolean
  exePath: string
  tmpDir: string
}): ToastChannel {
  if (!input.packaged) return 'dev'
  // A portable build unpacks itself into a temp directory and runs from there, so its
  // LocalServer32 path stops existing the moment it exits. Nothing can make that
  // activate reliably, which is the strongest argument for the in-app inbox below.
  const exe = input.exePath.toLowerCase()
  const tmp = input.tmpDir.toLowerCase()
  return exe.startsWith(tmp) ? 'portable' : 'installed'
}

/**
 * Claim this build's toast identity with Windows.
 *
 * Must run before the first window: Windows reads the AppUserModelID when a window
 * appears, and Electron writes its Start Menu shortcut from it. Doing it from
 * `Notifier.start()` — which runs after `createWindow()` — was already too late.
 */
export function configureToastIdentity(): void {
  if (process.platform !== 'win32') return

  const identity = toastIdentityFor({
    packaged: app.isPackaged,
    exePath: app.getPath('exe'),
    tmpDir: tmpdir()
  })

  try {
    app.setAppUserModelId(identity.aumid)
    // Pinned rather than generated. With no pin the activator class differs between
    // launches, so the shortcut on disk, the registry entry and the running process can
    // all disagree about who should receive a click.
    app.setToastActivatorCLSID(identity.clsid)
    log.info(`toast identity ${identity.aumid} ${identity.clsid}`)
  } catch (err) {
    // An unparsable CLSID throws. Notifications degrade; the inbox does not.
    log.warn('could not claim the toast identity', err)
  }
}

export function toastIdentityFor(input: {
  packaged: boolean
  exePath: string
  tmpDir: string
}): ToastIdentity {
  return TOAST_IDENTITY[toastChannelFor(input)]
}

/**
 * What a notification is called, and which row it becomes in the inbox.
 *
 * Pure and exported because this is a decision worth pinning rather than a formatting
 * detail. A tool run that fell through to the ordinary-reply branch was announced as
 * "Second Brain replied" — a title naming neither what ran nor where the answer went,
 * attached to a chat the user is deliberately never shown. Three symptoms, one omission,
 * and none of it visible from reading either branch on its own.
 *
 * Order matters: a tool wins over a task, because a scheduled run *of* a tool is still read
 * in the tool. There is nothing to open for the task.
 */
export function announcementFor(input: {
  what: 'result' | 'question'
  tool: { name: string } | null
  task: { name: string } | null
}): { title: string; kind: InboxKind } {
  const asking = input.what === 'question'

  if (input.tool) {
    return {
      title: asking ? `${input.tool.name} is asking` : input.tool.name,
      kind: 'tool'
    }
  }

  if (input.task) {
    return {
      title: asking ? `${input.task.name} is asking` : input.task.name,
      kind: asking ? 'question' : 'task'
    }
  }

  return {
    title: asking ? 'The agent is asking' : 'Second Brain replied',
    kind: asking ? 'question' : 'reply'
  }
}

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
  /** False when the desktop cannot show a toast at all. The inbox does not care. */
  private toastable = true

  /**
   * Toasts still in the notification centre.
   *
   * Held because nothing else references a Notification after `show()` returns, while a
   * Windows toast sits in Action Center for minutes — and its 'click' can arrive at any
   * point in that window. Bounded, and entries are dropped as they resolve.
   */
  private live = new Map<string, Notification>()

  constructor(
    private core: BrainCore,
    private agent: AgentManager,
    /** Brings the app forward and opens a chat, marking the inbox entry read. */
    private reveal: (sessionId: string | null, inboxId: string | null) => void
  ) {}

  start(): void {
    // Deliberately not gated on Notification.isSupported(). Everything worth telling the
    // user is recorded in the inbox whether or not this desktop can show a toast, so the
    // subscriptions have to be made either way — gating them behind the OS was how the
    // fallback ended up depending on the thing it exists to work around.
    this.toastable = Notification.isSupported()
    if (!this.toastable) {
      log.info('the desktop cannot show notifications; the inbox will still fill')
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
   * The tool a chat belongs to, if it is a tool's plumbing rather than a conversation.
   *
   * Through the session, not through `tools.bySession`: a tool remembers only its latest
   * run, so once the next one starts the previous run's toast can no longer name what it
   * came from — and a toast in Action Center outlives several runs easily.
   */
  private toolFor(sessionId: string | null): { id: string; name: string } | undefined {
    if (!sessionId) return undefined
    const toolId = this.core.chat.toolIdFor(sessionId)
    return toolId ? this.core.tools.get(toolId) : undefined
  }

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
    const tool = this.toolFor(question.sessionId)
    const seen = !this.unattended()
    const announcement = announcementFor({ what: 'question', tool: tool ?? null, task: task ?? null })
    this.send({
      title: announcement.title,
      body: preview(question.question, 140),
      sessionId: question.sessionId,
      taskId: task?.id ?? null,
      kind: announcement.kind,
      // Silent when they are right here: the card is already on screen, so this is a
      // marker in the notification centre rather than an interruption.
      silent: seen,
      alreadySeen: seen
    })
  }

  private onAgentEvent(event: AgentEvent): void {
    const settings = this.core.settings.notifications
    if (!settings.enabled) return

    if (event.type !== 'result') return

    const text = (event.text ?? '').trim()
    if (!text) return

    /*
     * A tool's run is announced as the tool, because that is the only place it can be read.
     *
     * Falling through to the ordinary-reply branch is what produced "Second Brain replied"
     * for a button press: a title that names neither what ran nor where the answer went,
     * pointing at an archived chat the user is deliberately never shown.
     */
    const tool = this.toolFor(event.sessionId)
    if (tool) {
      if (!settings.onReply || !this.unattended()) return

      const announcement = announcementFor({ what: 'result', tool, task: null })
      this.send({
        title: announcement.title,
        body: preview(text),
        sessionId: event.sessionId,
        kind: announcement.kind,
        silent: false
      })
      return
    }

    const task = this.core.tasks.bySession(event.sessionId)

    if (task) {
      if (!settings.onProactive) return
      // Same rule as an ordinary reply, and it matters more now that replying inside a
      // run's chat is the intended way to follow one up: a toast about a turn the user
      // is watching is noise.
      if (!this.unattended()) return
      // The heartbeat is told to say this exact phrase when it has nothing worth
      // raising, and it is meant to be the usual answer. Notifying about it would
      // turn a deliberately quiet feature into an hourly interruption.
      if (/^nothing to report\.?$/i.test(text)) return

      const announcement = announcementFor({ what: 'result', tool: null, task })
      this.send({
        title: announcement.title,
        body: preview(text),
        sessionId: event.sessionId,
        taskId: task.id,
        kind: announcement.kind,
        silent: false
      })
      return
    }

    // An ordinary chat reply. Only worth a toast if they walked away from it.
    if (!settings.onReply || !this.unattended()) return

    const announcement = announcementFor({ what: 'result', tool: null, task: null })
    this.send({
      title: announcement.title,
      body: preview(text),
      sessionId: event.sessionId,
      kind: announcement.kind,
      silent: false
    })
  }

  /* ---------------------------------------------------------------- sending */

  /**
   * Record it, then try to tell the operating system.
   *
   * In that order, and that is the whole design. The inbox row is written first and
   * unconditionally, so what happened is recoverable from inside the app; the toast is
   * best-effort on top. When Windows refuses to deliver a click — a normal state for a
   * dev run and an unfixable one for a portable build — nothing is lost.
   */
  private send(input: {
    title: string
    body: string
    sessionId: string | null
    taskId?: string | null
    kind: InboxKind
    silent: boolean
    /** True for something the user is plainly already looking at. */
    alreadySeen?: boolean
  }): void {
    const entry = this.core.inbox.add({
      sessionId: input.sessionId,
      taskId: input.taskId ?? null,
      kind: input.kind,
      title: input.title,
      body: input.body,
      // A question raised while the app has focus is already on screen; an unread badge
      // for it would break the rule this whole file is built on.
      read: input.alreadySeen === true
    })
    this.core.inbox.prune()
    this.core.broadcast('inbox:changed')

    if (!this.toastable) return

    try {
      const notification = new Notification({
        title: input.title,
        body: input.body,
        silent: input.silent
      })

      this.live.set(entry.id, notification)
      if (this.live.size > 32) {
        const oldest = this.live.keys().next().value
        if (oldest !== undefined) this.live.delete(oldest)
      }

      const settle = (): void => {
        this.live.delete(entry.id)
      }

      // The click has to land somewhere useful. A toast that only raises the window
      // leaves the user hunting for what it was about — especially for a scheduled run,
      // whose chat is archived and not in the recent list.
      notification.on('click', () => {
        log.info(`notification clicked (${input.kind})`)
        settle()
        this.reveal(input.sessionId, entry.id)
      })
      notification.on('close', settle)
      // Windows-only, and the one event that says the shell refused it. Without this
      // there was no way to tell "never shown" from "shown and ignored".
      notification.on('failed', (_event, error) => {
        settle()
        log.warn(`the desktop refused a notification: ${error}`)
      })

      notification.show()
      log.info(`notification shown (${input.kind}${input.silent ? ', silent' : ''})`)
    } catch (err) {
      log.warn('could not show a notification', err)
    }
  }
}
