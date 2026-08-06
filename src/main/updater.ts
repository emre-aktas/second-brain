import { shell } from 'electron'
import type { UpdateCapability, UpdateStatus, WhatsNew } from '@shared/types'
import CHANGELOG from '../../CHANGELOG.md?raw'
import { toastChannelFor } from './notify'
import { createLogger } from './logger'

const log = createLogger('updater')

/**
 * Getting a new version onto someone else's machine.
 *
 * The shape of this is decided by one fact: the user pushes, and everyone running the app
 * should end up on the new build without being told how. So the app asks GitHub for the
 * latest release, offers it with the notes that release carries, and — on one press —
 * downloads it, installs it, restarts, and says what changed.
 *
 * The honest part is that not every build can do the middle of that. A portable Windows
 * build has no installation to replace, and the macOS build is ad-hoc signed, which
 * Squirrel.Mac refuses to update: it validates the downloaded bundle's signature against the
 * running one and an ad-hoc signature satisfies nothing. Those builds are told about the
 * update and sent to the release page. Pretending otherwise would mean a button that
 * spins and then fails, which teaches the user to ignore the whole feature.
 */

const OWNER = 'emre-aktas'
const REPO = 'second-brain'

/** Long enough that a launch is never competing with a network request. */
const FIRST_CHECK_MS = 25_000

/**
 * How often to look after that.
 *
 * Six hours. The cost of a check is one small HTTPS request, so the limit is not bandwidth
 * but interruption: an update that appears while someone is mid-sentence is the same
 * annoyance whether it is right or not, and nothing here is urgent enough to earn more.
 */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

/* ------------------------------------------------------------------ decisions */

/**
 * Whether this copy can install an update, only be told about one, or neither.
 *
 * Built on `toastChannelFor` rather than restating "which kind of build am I": that function
 * already distinguishes a dev run, a portable exe and an installed copy, and two answers to
 * that question would eventually disagree.
 */
export function updateCapabilityFor(input: {
  platform: string
  packaged: boolean
  exePath: string
  tmpDir: string
}): UpdateCapability {
  const channel = toastChannelFor(input)

  // A dev run has no packaged app to replace, and pointing the updater at one would try to
  // install a release over `node_modules/electron`.
  if (channel === 'dev') return 'off'

  // Unpacked into a temp directory and run from there: there is no install location, and the
  // exe the user actually keeps is somewhere this process cannot know about.
  if (channel === 'portable') return 'manual'

  // Ad-hoc signed. See the block comment above — this is a property of the signature, not of
  // the platform, and it changes the day there is a Developer ID to sign with.
  if (input.platform === 'darwin') return 'manual'

  return 'install'
}

/**
 * Release notes as one markdown string.
 *
 * electron-updater hands these over in three shapes depending on the provider and the
 * options: a string, a list of per-version blocks, or nothing. Normalised here so the
 * renderer has one thing to render, and trimmed of the install boilerplate every release
 * body carries — that text is instructions for someone downloading by hand, and the user
 * reading this dialog is not downloading anything by hand.
 */
export function cleanReleaseNotes(
  raw: string | { version: string; note: string | null }[] | null | undefined
): string | null {
  if (!raw) return null

  const joined = Array.isArray(raw)
    ? raw
        .map((entry) => entry.note ?? '')
        .filter((note) => note.trim().length > 0)
        .join('\n\n')
    : raw

  const text = joined
    // GitHub release bodies come back as written, but a provider that has rendered them to
    // HTML would otherwise put tags in front of the user.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .trim()

  if (!text) return null

  // Everything from an "## Install" heading onwards is for a manual download.
  const cut = text.search(/^#{1,3}\s*(install|installation|getting started)\b/im)
  const trimmed = (cut === -1 ? text : text.slice(0, cut)).trim()

  return trimmed.length > 0 ? trimmed : null
}

/**
 * The changelog section for one version.
 *
 * Bundled into the app so "what changed" survives every install path — including the user
 * who downloaded the installer from GitHub by hand, where nothing was stored on the way past.
 * Headings are matched loosely (`## 0.2.0`, `## v0.2.0 — 2026-08-07`) because a changelog is
 * edited by a human and a strict parser would silently return nothing.
 */
export function notesFromChangelog(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/)
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const opens = new RegExp(`^#{1,3}\\s*v?${escaped}(\\s|$|[^\\d.])`)

  const start = lines.findIndex((line) => opens.test(line))
  if (start === -1) return null

  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    // The next release's heading ends this one. Deeper headings inside a section are kept.
    if (/^#{1,3}\s*v?\d+\.\d+\.\d+/.test(lines[i])) break
    body.push(lines[i])
  }

  const text = body.join('\n').trim()
  return text.length > 0 ? text : null
}

/**
 * Whether to show "what's new", and with which notes.
 *
 * Three cases, and the middle one is the one that is easy to get wrong. A first-ever launch
 * has no seen version: nothing was updated, so there is nothing to announce, and showing the
 * changelog to someone who has just installed the app reads as a changelog for a product they
 * have not used. A launch on the same version as last time is silent. Only a version that
 * changed under the user gets the dialog.
 */
export function whatsNewFor(input: {
  currentVersion: string
  seenVersion: string | null
  /** Notes stored just before the app restarted to install — the release's own. */
  storedVersion: string | null
  storedNotes: string | null
  changelog: string
  releaseUrl: string | null
}): WhatsNew | null {
  if (!input.seenVersion || input.seenVersion === input.currentVersion) return null

  const stored =
    input.storedVersion === input.currentVersion && input.storedNotes?.trim()
      ? input.storedNotes.trim()
      : null

  const notes = stored ?? notesFromChangelog(input.changelog, input.currentVersion)
  if (!notes) return null

  return { version: input.currentVersion, notes, releaseUrl: input.releaseUrl }
}

export function releaseUrlFor(version: string): string {
  return `https://github.com/${OWNER}/${REPO}/releases/tag/v${version}`
}

/* -------------------------------------------------------------------- engine */

/**
 * The slice of `electron-updater`'s `autoUpdater` this controller uses.
 *
 * Declared structurally so the probe can drive the whole state machine with a stub. The
 * alternative is a feature whose only test is "does it compile", on the one path in the app
 * that replaces the app.
 */
export interface UpdateEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: unknown
  on(event: string, listener: (...args: never[]) => void): unknown
  checkForUpdates(): Promise<{
    updateInfo: {
      version: string
      releaseNotes?: string | { version: string; note: string | null }[] | null
    }
  } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

interface Store {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
}

const KEY_SEEN = 'update/seenVersion'
const KEY_PENDING_VERSION = 'update/pendingVersion'
const KEY_PENDING_NOTES = 'update/pendingNotes'

/* ---------------------------------------------------------------- controller */

export class UpdateController {
  private status: UpdateStatus
  private timer: ReturnType<typeof setTimeout> | null = null
  private wired = false
  /** Set while a download is in flight, so a second press cannot start another. */
  private busy = false

  constructor(
    private readonly deps: {
      engine: UpdateEngine
      kv: Store
      currentVersion: string
      capability: UpdateCapability
      broadcast: (status: UpdateStatus) => void
      /** Injected so the probe does not open a browser. */
      openExternal?: (url: string) => void
      changelog?: string
    }
  ) {
    this.status = {
      phase: 'idle',
      capability: deps.capability,
      currentVersion: deps.currentVersion,
      version: null,
      notes: null,
      releaseUrl: null,
      percent: 0,
      bytesPerSecond: 0,
      checkedAt: null,
      message: null
    }
  }

  current(): UpdateStatus {
    return this.status
  }

  start(): void {
    if (this.deps.capability === 'off') {
      log.info('updates are off for this build (not packaged)')
      return
    }

    this.wire()

    // Deliberately not awaited and deliberately late. Nothing about a launch should wait on
    // a network request, and a check that fails is a logged line rather than a visible error.
    this.timer = setTimeout(() => void this.tick(), FIRST_CHECK_MS)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    await this.check().catch(() => undefined)
    this.timer = setTimeout(() => void this.tick(), CHECK_EVERY_MS)
  }

  /** Ask now. Never throws: a failed check is a state, not an exception to handle upstream. */
  async check(): Promise<UpdateStatus> {
    if (this.deps.capability === 'off') return this.status
    // A download in progress is a check already answered. Re-asking mid-download would
    // replace the version being fetched with the same one and reset the progress the user is
    // watching.
    if (this.busy) return this.status

    this.wire()
    this.emit({ phase: 'checking', message: null })

    try {
      const result = await this.deps.engine.checkForUpdates()
      const info = result?.updateInfo ?? null

      if (!info || info.version === this.deps.currentVersion) {
        this.emit({ phase: 'idle', version: null, notes: null, checkedAt: Date.now() })
        return this.status
      }

      this.emit({
        phase: 'available',
        version: info.version,
        notes: cleanReleaseNotes(info.releaseNotes),
        releaseUrl: releaseUrlFor(info.version),
        checkedAt: Date.now()
      })
    } catch (err) {
      // Offline is the common case and it is not an error the user caused, so it is
      // recorded as one line and shown only where they went looking for it.
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`update check failed: ${message}`)
      this.emit({ phase: 'error', message, checkedAt: Date.now() })
    }

    return this.status
  }

  /**
   * Download it, install it, come back.
   *
   * One method for the whole sequence because the user pressed one button. The notes are
   * written down *before* `quitAndInstall`, because after it this process is gone and the
   * next one has no way to learn what the release said.
   */
  async install(): Promise<void> {
    if (this.deps.capability !== 'install') {
      this.openRelease()
      return
    }
    if (this.busy) return
    if (this.status.phase !== 'available') {
      // Nothing has been offered yet — a fresh window pressing this, or a retry after a
      // failed check. Find out first rather than downloading blind.
      const settled = await this.check()
      if (settled.phase !== 'available') return
    }

    this.busy = true
    this.emit({ phase: 'downloading', percent: 0, bytesPerSecond: 0, message: null })

    try {
      await this.deps.engine.downloadUpdate()
    } catch (err) {
      this.busy = false
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`update download failed: ${message}`)
      this.emit({ phase: 'error', message })
    }
  }

  openRelease(): void {
    const url = this.status.releaseUrl ?? `https://github.com/${OWNER}/${REPO}/releases/latest`
    const open = this.deps.openExternal ?? ((target: string) => void shell.openExternal(target))
    open(url)
  }

  /**
   * What changed in the version now running, answered once.
   *
   * Reading it marks the version as seen, which is what stops a reload from bringing the
   * dialog back — and it marks it even when there is nothing to show, so a version with no
   * notes does not leave the app checking for ever.
   */
  whatsNew(): WhatsNew | null {
    const { kv, currentVersion } = this.deps
    const seenVersion = kv.get<string>(KEY_SEEN) ?? null

    const result = whatsNewFor({
      currentVersion,
      seenVersion,
      storedVersion: kv.get<string>(KEY_PENDING_VERSION) ?? null,
      storedNotes: kv.get<string>(KEY_PENDING_NOTES) ?? null,
      changelog: this.deps.changelog ?? CHANGELOG,
      releaseUrl: releaseUrlFor(currentVersion)
    })

    if (seenVersion !== currentVersion) {
      kv.set(KEY_SEEN, currentVersion)
      if (seenVersion) log.info(`updated from ${seenVersion} to ${currentVersion}`)
    }

    return result
  }

  /* ------------------------------------------------------------------ wiring */

  private wire(): void {
    if (this.wired) return
    this.wired = true

    const engine = this.deps.engine
    // The user presses a button to download; anything automatic here would be the app
    // spending someone's bandwidth on its own initiative.
    engine.autoDownload = false
    // Nor on quit: an install that happens because the app closed is an install nobody
    // agreed to, and it would land the "what's new" dialog on a launch weeks later.
    engine.autoInstallOnAppQuit = false
    engine.logger = {
      info: (message: unknown) => log.debug(String(message)),
      warn: (message: unknown) => log.warn(String(message)),
      error: (message: unknown) => log.warn(String(message)),
      debug: (message: unknown) => log.debug(String(message))
    }

    engine.on('download-progress', ((progress: {
      percent?: number
      bytesPerSecond?: number
    }) => {
      this.emit({
        phase: 'downloading',
        percent: Math.max(0, Math.min(100, Math.round(progress.percent ?? 0))),
        bytesPerSecond: Math.max(0, Math.round(progress.bytesPerSecond ?? 0))
      })
    }) as (...args: never[]) => void)

    engine.on('update-downloaded', ((info: {
      version: string
      releaseNotes?: string | { version: string; note: string | null }[] | null
    }) => {
      const notes = cleanReleaseNotes(info.releaseNotes) ?? this.status.notes

      // Written before the restart, because after it this process is gone. Stored against
      // the version they belong to so a stale pair cannot be shown for the wrong build.
      this.deps.kv.set(KEY_PENDING_VERSION, info.version)
      if (notes) this.deps.kv.set(KEY_PENDING_NOTES, notes)

      this.emit({ phase: 'installing', version: info.version, notes, percent: 100 })
      log.info(`installing ${info.version}`)

      // Silently, and relaunch afterwards. The user asked for an update, not for an
      // installer wizard — and `perMachine: false` means this needs no elevation.
      //
      // Deferred a tick so the 'installing' state reaches the window before it closes:
      // `quitAndInstall` tears the app down synchronously from here.
      setTimeout(() => this.deps.engine.quitAndInstall(true, true), 400)
    }) as (...args: never[]) => void)

    engine.on('error', ((err: Error) => {
      this.busy = false
      log.warn(`updater error: ${err?.message ?? String(err)}`)
      this.emit({ phase: 'error', message: err?.message ?? 'The update could not be fetched.' })
    }) as (...args: never[]) => void)
  }

  private emit(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    this.deps.broadcast(this.status)
  }
}
