import { useCallback, useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUpCircle, Check, Download, ExternalLink, Loader2, Sparkles } from 'lucide-react'
import type { UpdateStatus, WhatsNew } from '@shared/types'
import { api, onEvent } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/**
 * Everything about a new version, in one component.
 *
 * Three surfaces, and they are one thing because they are one story: a quiet marker in the
 * footer saying something is available; a sheet with what changed and a button that does the
 * whole job; and — after the restart — the same notes again, headed "What's new", because the
 * only moment a changelog is genuinely wanted is just after the thing changed.
 *
 * The footer is deliberately where the marker lives. An app that interrupts to announce its own
 * maintenance has misjudged whose time it is, and there is nothing here the user needs within
 * the minute. It is coloured, though: an update that never gets noticed is an update that never
 * gets installed.
 */

const PLUGINS = [remarkGfm]

function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return ''
  const mb = bytesPerSecond / 1_000_000
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bytesPerSecond / 1000)} kB/s`
}

export function Updates(): React.JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [whatsNew, setWhatsNew] = useState<WhatsNew | null>(null)
  const [open, setOpen] = useState(false)
  /** Dismissed for this run only. The footer marker stays; the sheet does not reopen itself. */
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    void api.updateStatus().then(setStatus).catch(() => undefined)
    // Asked once per launch, and asking is what marks the version as seen — so this cannot
    // be retried in a loop or the dialog would be spent on a failed render.
    void api.whatsNew().then(setWhatsNew).catch(() => undefined)
    return onEvent('update:changed', setStatus)
  }, [])

  /*
   * Open the sheet by itself the first time a version is offered.
   *
   * Once, per version, and only when nothing is in flight. The alternative — waiting for the
   * user to notice a small marker in the footer — is how an update sits uninstalled for weeks,
   * and the whole point of this feature is that the people using the app end up on the build
   * that was pushed.
   */
  useEffect(() => {
    if (!status || status.phase !== 'available' || !status.version) return
    if (dismissed === status.version) return
    setOpen(true)
  }, [status, dismissed])

  const close = useCallback(() => {
    setOpen(false)
    if (status?.version) setDismissed(status.version)
  }, [status])

  if (!status) return null

  const showMarker =
    status.phase === 'available' || status.phase === 'downloading' || status.phase === 'installing'

  return (
    <>
      {showMarker && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            'flex items-center gap-1.5 rounded text-primary',
            'transition-colors duration-150 hover:text-foreground active:scale-[0.96]'
          )}
        >
          {status.phase === 'available' ? (
            <ArrowUpCircle className="size-3" />
          ) : (
            <Loader2 className="size-3 animate-spin" />
          )}
          {status.phase === 'available' && `Version ${status.version} available`}
          {status.phase === 'downloading' && `Downloading ${status.percent}%`}
          {status.phase === 'installing' && 'Restarting to update'}
        </button>
      )}

      <UpdateSheet status={status} open={open} onClose={close} />
      <WhatsNewSheet whatsNew={whatsNew} onClose={() => setWhatsNew(null)} />
    </>
  )
}

/* ------------------------------------------------------------------ the offer */

function UpdateSheet({
  status,
  open,
  onClose
}: {
  status: UpdateStatus
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const busy = status.phase === 'downloading' || status.phase === 'installing'

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpCircle className="size-4 text-primary" />
            Version {status.version} is available
          </DialogTitle>
          <DialogDescription>
            {status.capability === 'install'
              ? `You are on ${status.currentVersion}. Second Brain will download the update, install it and restart itself.`
              : `You are on ${status.currentVersion}.`}
          </DialogDescription>
        </DialogHeader>

        {status.notes ? (
          <div className="max-h-[46vh] overflow-y-auto rounded-md border border-border bg-secondary/25 px-3 py-2.5">
            <div className="genui-prose selectable text-[12.5px] leading-relaxed text-foreground">
              <Markdown remarkPlugins={PLUGINS}>{status.notes}</Markdown>
            </div>
          </div>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">
            This release came without notes.
          </p>
        )}

        {/*
          Why this build cannot install it itself, said plainly at the point it matters. A
          button that spins and then fails teaches the user to ignore the whole feature.
        */}
        {status.capability === 'manual' && (
          <p className="text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
            This copy cannot replace itself — a portable build has nothing installed to
            replace, and the macOS build is signed ad-hoc, which the updater refuses to
            overwrite. Download it from the release page and install it the way you did the
            first time.
          </p>
        )}

        {status.phase === 'downloading' && (
          <div className="flex flex-col gap-1.5">
            <div className="h-1 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-[var(--ease-out)]"
                style={{ width: `${status.percent}%` }}
              />
            </div>
            <p className="text-[11px] tabular-nums text-muted-foreground">
              {status.percent}%
              {status.bytesPerSecond > 0 && ` · ${formatRate(status.bytesPerSecond)}`}
            </p>
          </div>
        )}

        {status.phase === 'error' && status.message && (
          <p className="text-[11.5px] leading-relaxed text-destructive text-pretty">
            {status.message}
          </p>
        )}

        <DialogFooter>
          {!busy && (
            <Button variant="ghost" onClick={onClose}>
              Later
            </Button>
          )}

          {status.capability === 'install' ? (
            <Button onClick={() => void api.installUpdate()} disabled={busy}>
              {status.phase === 'installing' ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Restarting
                </>
              ) : status.phase === 'downloading' ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Downloading
                </>
              ) : (
                <>
                  <Download className="size-3.5" />
                  Download and install
                </>
              )}
            </Button>
          ) : (
            <Button onClick={() => void api.openReleasePage()}>
              <ExternalLink className="size-3.5" />
              Open the release page
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* --------------------------------------------------------------- what changed */

function WhatsNewSheet({
  whatsNew,
  onClose
}: {
  whatsNew: WhatsNew | null
  onClose: () => void
}): React.JSX.Element | null {
  if (!whatsNew) return null

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            What&rsquo;s new in {whatsNew.version}
          </DialogTitle>
          <DialogDescription>Second Brain updated itself and is ready to go.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[52vh] overflow-y-auto rounded-md border border-border bg-secondary/25 px-3 py-2.5">
          <div className="genui-prose selectable text-[12.5px] leading-relaxed text-foreground">
            <Markdown remarkPlugins={PLUGINS}>{whatsNew.notes}</Markdown>
          </div>
        </div>

        <DialogFooter>
          {whatsNew.releaseUrl && (
            <Button
              variant="ghost"
              onClick={() => void api.openExternal(whatsNew.releaseUrl as string)}
            >
              <ExternalLink className="size-3.5" />
              Full release
            </Button>
          )}
          <Button onClick={onClose}>
            <Check className="size-3.5" />
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
