import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  Trash2
} from 'lucide-react'
import type { IntegrationSummary, SecretState } from '@shared/types'
import type { PresetDto } from '@shared/ipc'
import { api, errorMessage } from '@/lib/api'
import { useApp } from '@/store/app'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Badge, Card, Label, Spinner, Switch } from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip } from '@/components/ui/tooltip'
import { toast } from '@/components/ui/sonner'

/**
 * Approving an integration, and giving it the credential it needs.
 *
 * This is the user's half of `requiredSecrets`, and until now it did not exist. The agent could
 * register an integration — saved disabled, declaring the refs it needs, with the tool's reply
 * promising it would be "shown to the user for approval in the Integrations panel" — and there
 * was no Integrations panel in the running app. The component existed and was exported; nothing
 * imported it, and the panel rail had no entry for it. So the whole `requiredSecrets` design was
 * unreachable: the agent could declare a need that no surface could ever satisfy.
 *
 * The card is built around one question: *what will this be allowed to do if I say yes?* Hence
 * the full operation list with method and path, shown before approval rather than behind a
 * disclosure. "Three GET endpoints under api.figma.com" is a decision someone can make; "an
 * integration the agent wrote" is a request to trust a summary.
 */

/* -------------------------------------------------------------------- helpers */

function statusTone(status: IntegrationSummary['status']): {
  label: string
  className: string
} {
  switch (status) {
    case 'enabled':
      return { label: 'enabled', className: 'text-success' }
    case 'pending':
      return { label: 'needs a credential', className: 'text-warning' }
    case 'disabled':
      return { label: 'disabled', className: 'text-muted-foreground' }
  }
}

/**
 * A hint with its URL as a link.
 *
 * `hint` is written by the agent and almost always contains the address of the page the token
 * comes from. Left as text it is something to retype; as a link it is the difference between
 * "go and find your Figma settings" and one click.
 */
function HintText({ hint }: { hint: string }): React.JSX.Element {
  const match = /https?:\/\/[^\s)]+/.exec(hint)
  if (!match) return <>{hint}</>

  const url = match[0].replace(/[.,]$/, '')
  return (
    <>
      {hint.slice(0, match.index)}
      <button
        type="button"
        onClick={() => void api.openExternal(url)}
        className="underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        {url}
      </button>
      {hint.slice(match.index + url.length)}
    </>
  )
}

/** `yyyy-mm-dd` for a date input, in local time — the user's 7 days, not UTC's. */
function toDateInput(ms: number | null): string {
  if (ms === null) return ''
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * A date input read as the *end* of that day.
 *
 * A 7-day token entered as its expiry date should not read as expired from midnight of that
 * morning, which is what parsing the value alone would do.
 */
function fromDateInput(value: string): number | null {
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
}

/* ---------------------------------------------------------------- the panel */

export function IntegrationsPanel(): React.JSX.Element {
  const [summaries, setSummaries] = useState<IntegrationSummary[]>([])
  const [presets, setPresets] = useState<PresetDto[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const secretsEncrypted = useApp((s) => s.bootstrap?.secretsEncrypted ?? true)
  const webhookBaseUrl = useApp((s) => s.bootstrap?.webhookBaseUrl ?? '')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [list, available] = await Promise.all([
        api.listIntegrationSummaries(),
        api.listPresets()
      ])
      setSummaries(list)
      setPresets(available)
    } catch (err) {
      // Reported rather than left as a spinner: a panel that never finishes loading is
      // indistinguishable from a panel with nothing in it, which is the failure this whole
      // screen exists to undo.
      toast.error('Could not read the integrations', { description: errorMessage(err) })
    } finally {
      setLoading(false)
    }
  }, [])

  /** The card the agent asked to put in front of the user, if it asked. */
  const [focused, setFocused] = useState<string | null>(null)

  useEffect(() => {
    void refresh()
    const offChanged = window.brain.on('integrations:changed', () => void refresh())
    // The agent cannot write a credential, so this is how it does the rest of the job: it opens
    // the panel at the right card with the field ready.
    const offFocus = window.brain.on('integrations:focus', (payload) => {
      const { integrationId } = payload as { integrationId: string }
      setFocused(integrationId)
      void refresh()
    })
    return () => {
      offChanged()
      offFocus()
    }
  }, [refresh])

  const act = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    setBusyId(id)
    try {
      await action()
      await refresh()
    } catch (err) {
      toast.error('That did not work', { description: errorMessage(err) })
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="text-muted-foreground" />
      </div>
    )
  }

  const pending = summaries.filter((summary) => summary.status === 'pending')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-[13px] font-semibold text-foreground">Integrations</h2>
        {pending.length > 0 && (
          <span className="text-[11px] text-warning">
            {pending.length === 1 ? '1 waiting on you' : `${pending.length} waiting on you`}
          </span>
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 px-3 py-3">
          {!secretsEncrypted && (
            <div className="rounded-md border border-warning/30 bg-warning/8 px-2.5 py-2">
              <p className="text-[12px] leading-relaxed text-warning text-pretty">
                The OS keychain is unavailable on this machine, so credentials are encrypted with a
                local key instead. That protects them from being read by accident — a backup, a
                synced folder — but not from a program running as you.
              </p>
            </div>
          )}

          {summaries.length === 0 && presets.length === 0 && (
            <p className="px-1 py-6 text-center text-[12.5px] leading-relaxed text-muted-foreground text-pretty">
              Nothing connected yet. Ask in the conversation — the agent can write an integration
              for a service and hand it back here for you to approve.
            </p>
          )}

          {summaries.map((summary) => (
            <IntegrationCard
              key={summary.id}
              summary={summary}
              busy={busyId === summary.id}
              webhookBaseUrl={webhookBaseUrl}
              highlighted={focused === summary.id}
              onAct={(action) => void act(summary.id, action)}
            />
          ))}

          {presets.length > 0 && (
            <section>
              <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
                Available
              </h3>
              <div className="flex flex-col gap-1.5">
                {presets.map((preset) => (
                  <div
                    key={preset.id}
                    className="flex items-start justify-between gap-2 rounded-md border border-border/70 bg-secondary/20 px-2.5 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-foreground">{preset.name}</p>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground text-pretty">
                        {preset.description}
                      </p>
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => void act(preset.id, () => api.installPreset(preset.id))}
                    >
                      Add
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

/* ----------------------------------------------------------------- one card */

function IntegrationCard({
  summary,
  busy,
  webhookBaseUrl,
  highlighted,
  onAct
}: {
  summary: IntegrationSummary
  busy: boolean
  webhookBaseUrl: string
  /** The agent asked for this one to be in front of the user. */
  highlighted: boolean
  onAct: (action: () => Promise<unknown>) => void
}): React.JSX.Element {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const tone = statusTone(summary.status)
  const expiredRefs = summary.secrets.filter((secret) => secret.expired)

  /*
   * A card opens when there is something for the user to do.
   *
   * Pending is the obvious case: the previous card put the secret field behind a click on the
   * title, an interaction with no affordance, on the one row whose whole purpose was to ask for
   * something. An expired credential is the same case wearing different clothes, and it took a
   * probe to notice — the card was showing "Rotate it" in a warning while the Rotate button sat
   * behind that same undiscoverable click. Telling someone to act and hiding the control is
   * worse than not telling them.
   */
  const needsAttention = summary.status === 'pending' || expiredRefs.length > 0
  const [open, setOpen] = useState(needsAttention || highlighted)

  // Opened by the agent after the fact, not only on mount: the panel is usually already on
  // screen when the agent decides the user needs to see this one.
  useEffect(() => {
    if (highlighted) setOpen(true)
  }, [highlighted])

  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    try {
      const probe = await api.probeIntegration(summary.id)
      setResult({ ok: probe.ok, message: probe.message })
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) })
    } finally {
      setTesting(false)
    }
  }

  /*
   * Saving a credential tests it, without being asked.
   *
   * Save-then-find-the-test-button-then-find-the-switch is three decisions for one intention.
   * The registry answers "still missing X" for an integration that is not ready yet, so this is
   * informative in both cases and there is no state where pressing Save leaves the user guessing
   * whether the thing they pasted actually works.
   */
  const savedSecret = (): void => {
    void test()
  }

  return (
    <Card className={cn('bg-card/60', summary.status === 'pending' && 'border-warning/40')}>
      <div className="flex items-start justify-between gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
        >
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                summary.health === 'ok' && 'bg-success',
                summary.health === 'error' && 'bg-destructive',
                summary.health === 'needs-auth' && 'bg-warning',
                (summary.health === 'unknown' || summary.health === 'disabled') && 'bg-border'
              )}
              aria-hidden="true"
            />
            <span className="truncate">{summary.name}</span>
            <Badge tone="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
              {summary.kind}
            </Badge>
          </p>
          <p className="mt-0.5 truncate text-[11px]">
            <span className={tone.className}>{tone.label}</span>
            <span className="text-muted-foreground">
              {summary.operations.length > 0 && ` · ${summary.operations.length} operation(s)`}
              {summary.createdBy === 'agent' && ' · built by the agent'}
            </span>
          </p>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          {busy && <Spinner className="size-3.5 text-muted-foreground" />}
          {/*
            Enabling is gated on every declared credential being present. Disabled with a reason
            on hover rather than absent: a control that vanishes leaves the user looking for it,
            and the main process refuses the same case anyway — this only saves them the error.
          */}
          <Tooltip
            content={
              summary.ready
                ? summary.status === 'enabled'
                  ? 'Disable'
                  : 'Enable'
                : `Needs ${summary.missingSecrets.join(', ')} first`
            }
          >
            <span>
              <Switch
                checked={summary.status === 'enabled'}
                disabled={!summary.ready}
                onCheckedChange={(next) =>
                  onAct(() => api.setIntegrationEnabled(summary.id, next))
                }
                aria-label={`Enable ${summary.name}`}
              />
            </span>
          </Tooltip>
        </div>
      </div>

      {expiredRefs.length > 0 && (
        <p className="mx-2.5 mb-2 flex items-start gap-1.5 rounded border border-warning/30 bg-warning/8 px-2 py-1.5 text-[11px] leading-snug text-warning">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          <span>
            {expiredRefs.map((secret) => secret.label).join(', ')} passed the expiry you set.
            Rotate it — a short-lived token that has run out fails silently until something asks
            for it.
          </span>
        </p>
      )}

      {open && (
        <div className="border-t border-border/60 px-2.5 py-2.5">
          <p className="text-[12px] leading-relaxed text-muted-foreground text-pretty">
            {summary.description}
          </p>

          {summary.baseUrl && (
            <p className="mt-1.5 break-all font-mono text-[11px] text-muted-foreground">
              {summary.baseUrl}
            </p>
          )}

          {summary.kind === 'webhook' && webhookBaseUrl && (
            <p className="mt-1.5 break-all font-mono text-[11px] text-muted-foreground">
              POST {webhookBaseUrl}/{summary.operations[0]?.path ?? ''}
            </p>
          )}

          {summary.lastError && (
            <p className="mt-1.5 rounded border border-destructive/25 bg-destructive/8 px-2 py-1 text-[11px] leading-snug text-destructive">
              {summary.lastError}
            </p>
          )}

          {/* ------------------------------------------- what it will be allowed to do */}

          <div className="mt-3">
            <p className="text-[11px] font-medium text-foreground">
              What it will be allowed to call
            </p>
            {summary.operations.length === 0 ? (
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground text-pretty">
                An MCP server declares its own operations when it connects, so there is nothing to
                list from the manifest. Enable it and press Test to see what it offers.
              </p>
            ) : (
              <ul className="mt-1 flex flex-col gap-0.5">
                {summary.operations.map((op) => (
                  <li key={op.name} className="flex items-baseline gap-1.5 text-[11px]">
                    {op.method && (
                      <span
                        className={cn(
                          'shrink-0 font-mono',
                          op.mutating ? 'text-warning' : 'text-muted-foreground'
                        )}
                      >
                        {op.method}
                      </span>
                    )}
                    <span className="break-all font-mono text-foreground/80">
                      {op.path ?? op.name}
                    </span>
                    {op.mutating && (
                      <span className="shrink-0 text-[10px] text-warning">changes data</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ------------------------------------------------------------ credentials */}

          {summary.secrets.length > 0 && (
            <div className="mt-3 flex flex-col gap-3">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                <KeyRound className="size-3" />
                Credentials
              </p>
              {summary.secrets.map((secret) => (
                    <SecretField
                  key={secret.ref}
                  secret={secret}
                  integrationId={summary.id}
                  onAct={onAct}
                  onSaved={savedSecret}
                />
              ))}
            </div>
          )}

          {/* ----------------------------------------------------------------- actions */}

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Button size="xs" onClick={() => void test()} disabled={testing || !summary.ready}>
              {testing ? <Loader2 className="size-3 animate-spin" /> : <Plug className="size-3" />}
              Test connection
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="text-destructive"
              onClick={() => onAct(() => api.removeIntegration(summary.id))}
            >
              Remove
            </Button>
          </div>

          {result && (
            <div
              className={cn(
                'mt-2 rounded border px-2 py-1.5',
                result.ok
                  ? 'border-success/30 bg-success/8'
                  : 'border-destructive/25 bg-destructive/8'
              )}
            >
              <p
                className={cn(
                  'whitespace-pre-wrap break-words text-[11px] leading-snug',
                  result.ok ? 'text-success' : 'text-destructive'
                )}
              >
                {result.message}
              </p>
              {/*
                The last step, offered where the good news is rather than back up at the switch.
                A passing test is the moment the user has their answer; making them then hunt for
                a toggle in the header is the point at which people stop.
              */}
              {result.ok && summary.ready && summary.status !== 'enabled' && (
                <Button
                  size="xs"
                  className="mt-1.5"
                  onClick={() => onAct(() => api.setIntegrationEnabled(summary.id, true))}
                >
                  <Check className="size-3" />
                  Turn it on
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

/* --------------------------------------------------------------- one secret */

function SecretField({
  secret,
  integrationId,
  onAct,
  onSaved
}: {
  secret: SecretState
  /** Recorded with the value, so a ref reused by another manifest can be flagged rather than assumed. */
  integrationId: string
  onAct: (action: () => Promise<unknown>) => void
  /** Called once the value is stored, so the card can test it straight away. */
  onSaved: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [expiry, setExpiry] = useState(() => toDateInput(secret.expiresAt))
  const [revealed, setRevealed] = useState<string | null>(null)
  /** Open for an unset secret; a set one shows its state until the user asks to replace it. */
  const [editing, setEditing] = useState(!secret.isSet)

  const save = (): void => {
    /*
     * Trimmed, and that is not cosmetic.
     *
     * A token copied from a web page arrives with a trailing newline or a leading space more
     * often than not, and the failure it causes is the worst kind: the value looks right behind
     * the dots, the service answers 401, and there is nothing on screen to suggest whitespace.
     */
    const value = draft.trim()
    if (!value) return

    setDraft('')
    setEditing(false)
    setRevealed(null)
    onAct(async () => {
      await api.setSecret(secret.ref, value, fromDateInput(expiry), integrationId)
      toast.success(`${secret.label} saved`)
      onSaved()
    })
  }

  const reveal = async (): Promise<void> => {
    if (revealed) {
      setRevealed(null)
      return
    }
    try {
      // Fetched on the press, held in this component, and dropped the moment it is hidden or the
      // field is replaced. Never part of the list the panel renders from.
      setRevealed(await api.revealSecret(secret.ref))
    } catch (err) {
      toast.error('Could not read it back', { description: errorMessage(err) })
    }
  }

  return (
    <div>
      <Label htmlFor={secret.ref} className="text-[11px] text-foreground/90">
        {secret.label}
      </Label>
      {secret.hint && (
        <p className="mb-1 text-[11px] leading-snug text-muted-foreground text-pretty">
          <HintText hint={secret.hint} />
        </p>
      )}

      {/*
        A credential this integration did not ask for.

        Refs are one flat namespace, so a manifest can declare one the user already filled in
        elsewhere — and it then reads as ready to enable without its author ever having asked for
        anything. Usually that is two integrations against one service. Occasionally it is not,
        and the difference is worth a line.
      */}
      {secret.borrowedFrom && (
        <p className="mb-1 flex items-start gap-1.5 rounded border border-warning/30 bg-warning/8 px-2 py-1 text-[11px] leading-snug text-warning">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          <span>
            You entered this for <span className="font-medium">{secret.borrowedFrom}</span>, not
            for this integration. Check the base URL above before turning it on.
          </span>
        </p>
      )}

      {editing ? (
        <>
          <div className="flex gap-1.5">
            <Input
              id={secret.ref}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the value"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              // Enter saves. A one-field form that needs the mouse for its only action is a form
              // that has forgotten what it is.
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  save()
                }
              }}
              className="h-8 text-[12px]"
            />
            <Button size="sm" disabled={!draft.trim()} onClick={save}>
              Save and test
            </Button>
            {secret.isSet && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Label htmlFor={`${secret.ref}-expiry`} className="text-[10.5px] text-muted-foreground">
              Expires
            </Label>
            {/*
              A native date input, and its placeholder is in the OS locale rather than the app's.
              `lang` does not change that — Chromium takes the format from the application locale,
              so the only way to force English here is to set the locale for the whole app, which
              would also override the user's own date and time formatting everywhere else. A
              system control rendering in the system format is the lesser oddity, and the same
              thing the file dialog already does.
            */}
            <Input
              id={`${secret.ref}-expiry`}
              type="date"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
              className="h-7 w-[132px] text-[11px]"
            />
            <span className="text-[10.5px] text-muted-foreground">
              optional — a warning appears once it passes
            </span>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Check className="size-3 text-success" />
            set {secret.updatedAt ? formatRelativeTime(secret.updatedAt) : ''}
            {secret.encrypted ? ' · in the OS keychain' : ' · with a local key'}
            {secret.expiresAt !== null &&
              ` · expires ${formatRelativeTime(secret.expiresAt)}`}
          </p>

          {revealed !== null && (
            <p className="select-all break-all rounded border border-border bg-secondary/40 px-2 py-1 font-mono text-[11px] text-foreground">
              {revealed}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => void reveal()}>
              {revealed ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
              {revealed ? 'Hide' : 'Reveal'}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
              <RefreshCw className="size-3" />
              Rotate
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="text-destructive"
              onClick={() => {
                setRevealed(null)
                onAct(async () => {
                  await api.deleteSecret(secret.ref)
                  toast.success(`${secret.label} removed`)
                })
              }}
            >
              <Trash2 className="size-3" />
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
