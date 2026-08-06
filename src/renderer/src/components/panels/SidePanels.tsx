import { useEffect, useRef, useState } from 'react'
import type { AgentEffort, IntegrationRecord, Suggestion } from '@shared/types'
import { EFFORT_OPTIONS, MODEL_OPTIONS } from '@shared/types'
import type { PresetDto } from '@shared/ipc'
import { api, errorMessage } from '@/lib/api'
import { useApp } from '@/store/app'
import { cn, formatRelativeTime } from '@/lib/utils'
import {
  Badge,
  Card,
  EmptyState,
  Label,
  NativeSelect,
  Progress,
  Separator,
  Spinner,
  Switch
} from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip } from '@/components/ui/tooltip'
import { toast } from '@/components/ui/sonner'

/* ============================================================== activity */

export function ActivityPanel(): React.JSX.Element {
  const activity = useApp((s) => s.activity)
  const suggestions = useApp((s) => s.suggestions)
  const applySuggestion = useApp((s) => s.applySuggestion)
  const dismissSuggestion = useApp((s) => s.dismissSuggestion)
  const openNode = useApp((s) => s.openNode)
  const [running, setRunning] = useState(false)

  const runCurator = async (): Promise<void> => {
    setRunning(true)
    try {
      const report = await api.runCurator()
      toast.success('Pass complete', {
        description:
          report.linksAdded || report.suggestionsCreated
            ? `${report.linksAdded} connection(s), ${report.suggestionsCreated} suggestion(s) from ${report.notesConsidered} notes.`
            : report.skippedReason ?? 'Nothing new to propose.'
      })
      await useApp.getState().refreshSuggestions()
    } catch (err) {
      toast.error('Pass failed', { description: errorMessage(err) })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-[13px] font-semibold text-foreground">Activity</h2>
        <Tooltip content="Look for connections now, without waiting for idle time">
          <Button variant="outline" size="xs" onClick={() => void runCurator()} disabled={running}>
            {running ? <Spinner className="size-3" /> : null}
            Curate now
          </Button>
        </Tooltip>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-3 py-3">
          {suggestions.length > 0 && (
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Suggestions · {suggestions.length}
              </h3>
              <div className="flex flex-col gap-2">
                {suggestions.map((suggestion) => (
                  <SuggestionCard
                    key={suggestion.id}
                    suggestion={suggestion}
                    onApply={() => void applySuggestion(suggestion.id)}
                    onDismiss={() => void dismissSuggestion(suggestion.id)}
                  />
                ))}
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Timeline
            </h3>
            {activity.length === 0 ? (
              <EmptyState title="Nothing yet" description="Everything you and the agent do shows up here." />
            ) : (
              <ol className="relative flex flex-col gap-2.5 pl-3.5">
                <span className="absolute bottom-1 left-[2px] top-1.5 w-px bg-border" aria-hidden="true" />
                {activity.map((entry) => (
                  <li key={entry.id} className="relative">
                    <span
                      className={cn(
                        'absolute -left-3.5 top-[6px] size-1.5 rounded-full ring-2 ring-background',
                        entry.actor === 'agent' && 'bg-primary',
                        entry.actor === 'curator' && 'bg-info',
                        entry.actor === 'user' && 'bg-muted-foreground',
                        entry.actor === 'external' && 'bg-warning',
                        entry.actor.startsWith('integration:') && 'bg-success',
                        entry.actor === 'system' && 'bg-border'
                      )}
                      aria-hidden="true"
                    />
                    <button
                      type="button"
                      disabled={!entry.nodeId}
                      onClick={() => entry.nodeId && openNode(entry.nodeId)}
                      className={cn(
                        'block w-full text-left',
                        entry.nodeId && 'rounded transition-colors duration-150 hover:text-foreground'
                      )}
                    >
                      <p className="text-[12.5px] leading-snug text-foreground">{entry.title}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {entry.actor} · {formatRelativeTime(entry.ts)}
                      </p>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}

function SuggestionCard({
  suggestion,
  onApply,
  onDismiss
}: {
  suggestion: Suggestion
  onApply: () => void
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <Card className="bg-secondary/25 px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium leading-snug text-foreground text-pretty">
          {suggestion.title}
        </p>
        <Badge tone="outline" className="shrink-0">
          {suggestion.kind}
        </Badge>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground text-pretty">
        {suggestion.rationale}
      </p>
      <div className="mt-2 flex items-center gap-1.5">
        {suggestion.autoApplicable && (
          <Button size="xs" onClick={onApply}>
            Accept
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </Card>
  )
}

/* ========================================================== integrations */

export function IntegrationsPanel(): React.JSX.Element {
  const [records, setRecords] = useState<IntegrationRecord[]>([])
  const [presets, setPresets] = useState<PresetDto[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const secretsEncrypted = useApp((s) => s.bootstrap?.secretsEncrypted ?? true)
  const webhookBaseUrl = useApp((s) => s.bootstrap?.webhookBaseUrl ?? '')

  const refresh = async (): Promise<void> => {
    const [list, available] = await Promise.all([api.listIntegrations(), api.listPresets()])
    setRecords(list)
    setPresets(available)
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
    return window.brain.on('integrations:changed', () => void refresh())
  }, [])

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-3 py-2">
        <h2 className="text-[13px] font-semibold text-foreground">Integrations</h2>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-3 py-3">
          {!secretsEncrypted && (
            <div className="rounded-md border border-warning/30 bg-warning/8 px-2.5 py-2">
              <p className="text-[12px] leading-relaxed text-warning text-pretty">
                The OS keychain is unavailable, so credentials are stored obfuscated rather than
                encrypted. Avoid connecting anything sensitive on this machine.
              </p>
            </div>
          )}

          {records.length > 0 && (
            <section className="flex flex-col gap-2">
              {records.map((record) => (
                <IntegrationCard
                  key={record.manifest.id}
                  record={record}
                  busy={busyId === record.manifest.id}
                  webhookBaseUrl={webhookBaseUrl}
                  onToggle={(enabled) =>
                    void act(record.manifest.id, () =>
                      api.setIntegrationEnabled(record.manifest.id, enabled)
                    )
                  }
                  onTest={() =>
                    void act(record.manifest.id, async () => {
                      const result = await api.testIntegration(record.manifest.id)
                      if (result.ok) toast.success(result.message)
                      else toast.error('Connection failed', { description: result.message })
                    })
                  }
                  onAuthorize={() =>
                    void act(record.manifest.id, async () => {
                      const result = await api.authorizeIntegration(record.manifest.id)
                      if (result.ok) toast.success(result.message)
                      else toast.error('Could not connect', { description: result.message })
                    })
                  }
                  onRemove={() =>
                    void act(record.manifest.id, () => api.removeIntegration(record.manifest.id))
                  }
                  onSaveSecret={(ref, value) =>
                    void act(record.manifest.id, async () => {
                      await api.setSecret(ref, value)
                      toast.success('Saved')
                    })
                  }
                />
              ))}
            </section>
          )}

          {presets.length > 0 && (
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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

          <p className="text-[12px] leading-relaxed text-muted-foreground text-pretty">
            Anything with an MCP server connects directly. For services without one, ask the agent
            in chat — it can write the integration itself and hand it back here for you to approve.
          </p>
        </div>
      </ScrollArea>
    </div>
  )
}

function IntegrationCard({
  record,
  busy,
  webhookBaseUrl,
  onToggle,
  onTest,
  onAuthorize,
  onRemove,
  onSaveSecret
}: {
  record: IntegrationRecord
  busy: boolean
  webhookBaseUrl: string
  onToggle: (enabled: boolean) => void
  onTest: () => void
  onAuthorize: () => void
  onRemove: () => void
  onSaveSecret: (ref: string, value: string) => void
}): React.JSX.Element {
  const { manifest, health, lastError, toolCount } = record
  const [open, setOpen] = useState(false)
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({})

  const isOAuth = manifest.kind === 'rest' && manifest.auth.type === 'oauth2'

  return (
    <Card className="bg-card/60">
      <div className="flex items-start justify-between gap-2 px-2.5 py-2">
        <button type="button" onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                health === 'ok' && 'bg-success',
                health === 'error' && 'bg-destructive',
                health === 'needs-auth' && 'bg-warning',
                (health === 'unknown' || health === 'disabled') && 'bg-border'
              )}
              aria-hidden="true"
            />
            <span className="truncate">{manifest.name}</span>
            <Badge tone="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
              {manifest.kind}
            </Badge>
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {manifest.enabled
              ? toolCount > 0
                ? `${toolCount} operation(s)`
                : 'enabled'
              : 'disabled'}
            {manifest.createdBy === 'agent' && ' · built by the agent'}
          </p>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          {busy && <Spinner className="size-3.5 text-muted-foreground" />}
          <Switch checked={manifest.enabled} onCheckedChange={onToggle} aria-label="Enable" />
        </div>
      </div>

      {open && (
        <div className="border-t border-border/60 px-2.5 py-2.5">
          <p className="text-[12px] leading-relaxed text-muted-foreground text-pretty">
            {manifest.description}
          </p>

          {lastError && (
            <p className="mt-1.5 rounded border border-destructive/25 bg-destructive/8 px-2 py-1 text-[11px] text-destructive">
              {lastError}
            </p>
          )}

          {manifest.kind === 'webhook' && webhookBaseUrl && (
            <p className="mt-1.5 break-all font-mono text-[11px] text-muted-foreground">
              POST {webhookBaseUrl}/{manifest.path}
            </p>
          )}

          {(manifest.requiredSecrets ?? []).length > 0 && (
            <div className="mt-2.5 flex flex-col gap-2">
              {manifest.requiredSecrets!.map((secret) => (
                <div key={secret.ref}>
                  <Label htmlFor={secret.ref} className="text-[11px] text-muted-foreground">
                    {secret.label}
                  </Label>
                  {secret.hint && (
                    <p className="mb-1 text-[11px] leading-snug text-muted-foreground/80 text-pretty">
                      {secret.hint}
                    </p>
                  )}
                  <div className="flex gap-1.5">
                    <Input
                      id={secret.ref}
                      type="password"
                      autoComplete="off"
                      placeholder="Paste value"
                      value={secretDrafts[secret.ref] ?? ''}
                      onChange={(event) =>
                        setSecretDrafts((drafts) => ({ ...drafts, [secret.ref]: event.target.value }))
                      }
                      className="h-8 text-[12px]"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!secretDrafts[secret.ref]}
                      onClick={() => {
                        onSaveSecret(secret.ref, secretDrafts[secret.ref])
                        setSecretDrafts((drafts) => ({ ...drafts, [secret.ref]: '' }))
                      }}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {isOAuth && (
              <Button size="xs" onClick={onAuthorize}>
                Connect account
              </Button>
            )}
            <Button size="xs" variant="outline" onClick={onTest}>
              Test
            </Button>
            <Button size="xs" variant="ghost" className="text-destructive" onClick={onRemove}>
              Remove
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

/* ============================================================== settings */

export function SettingsPanel(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const bootstrap = useApp((s) => s.bootstrap)
  const updateSettings = useApp((s) => s.updateSettings)
  const stats = useApp((s) => s.stats)
  const budget = useApp((s) => s.budget)
  const usage = useApp((s) => s.usage)
  const [reindexing, setReindexing] = useState(false)

  if (!settings || !bootstrap) return <Spinner />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-3 py-2">
        <h2 className="text-[13px] font-semibold text-foreground">Settings</h2>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-3 py-3">
          <section>
            <SectionTitle>Workspace</SectionTitle>
            <p className="break-all font-mono text-[11px] text-muted-foreground">{bootstrap.workspace.root}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="xs" variant="outline" onClick={() => void api.openWorkspace()}>
                Open folder
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void api.chooseWorkspace().then((path) => {
                    if (path) toast.success('Workspace changed', { description: 'Restart to load it.' })
                  })
                }
              >
                Change…
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={reindexing}
                onClick={() => {
                  setReindexing(true)
                  void api
                    .reindex()
                    .then((report) =>
                      toast.success('Reindexed', {
                        description: `${report.scanned} notes, ${report.edges} connections in ${report.durationMs}ms.`
                      })
                    )
                    .finally(() => setReindexing(false))
                }}
              >
                {reindexing ? <Spinner className="size-3" /> : null}
                Reindex
              </Button>
            </div>
          </section>

          <Separator />

          <section>
            <SectionTitle>Agent</SectionTitle>
            <Row label="Claude CLI">
              <span className={cn('text-[12px]', bootstrap.agent.available ? 'text-success' : 'text-destructive')}>
                {bootstrap.agent.version ?? 'not found'}
              </span>
            </Row>
            {bootstrap.agent.auth && (
              <>
                <Row label="Signed in as">
                  <span className="text-[12px] text-muted-foreground">
                    {bootstrap.agent.auth.email ?? 'unknown'}
                  </span>
                </Row>
                <Row label="Billing">
                  <span
                    className={cn(
                      'text-[12px]',
                      bootstrap.agent.auth.onSubscription ? 'text-success' : 'text-warning'
                    )}
                  >
                    {bootstrap.agent.auth.onSubscription
                      ? `${bootstrap.agent.auth.subscriptionType ?? 'subscription'} plan`
                      : 'metered API credits'}
                  </span>
                </Row>
                <p className="mb-1 mt-0.5 text-[11px] leading-relaxed text-muted-foreground text-pretty">
                  {bootstrap.agent.auth.onSubscription
                    ? 'The agent runs your local Claude Code login, so usage counts against this plan. API-key and custom-endpoint environment variables are stripped before the CLI starts, so it cannot fall back to metered credits.'
                    : 'The CLI is authenticating with an API key, which is billed per token. Run `claude auth login` to switch it to your subscription.'}
                </p>
              </>
            )}
            <Row label="Model" hint={MODEL_OPTIONS.find((m) => m.id === settings.model)?.hint}>
              <NativeSelect
                value={settings.model}
                onChange={(model) => void updateSettings({ model })}
                options={MODEL_OPTIONS.map((m) => ({ value: m.id, label: m.label }))}
              />
            </Row>
            <Row
              label="Thinking"
              hint={EFFORT_OPTIONS.find((e) => e.id === settings.effort)?.hint}
            >
              <NativeSelect
                value={settings.effort}
                onChange={(effort) => void updateSettings({ effort: effort as AgentEffort })}
                options={EFFORT_OPTIONS.map((e) => ({ value: e.id, label: e.label }))}
              />
            </Row>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground text-pretty">
              A model or thinking change applies to the next conversation you start, or when you
              switch a conversation's mode.
            </p>
          </section>

          <Separator />

          <section>
            <SectionTitle>Usage limits</SectionTitle>

            {budget?.onSubscription && settings.budget.mode === 'auto' && (
              <p className="mb-2 rounded-md border border-success/25 bg-success/8 px-2.5 py-2 text-[11px] leading-relaxed text-success text-pretty">
                Running on your Claude plan, so there is no per-token charge to cap. Spend caps stand
                down automatically and the usage windows below show your real limits instead.
              </p>
            )}

            <Row
              label="Spend caps"
              hint="Only relevant when the CLI bills metered API credits"
            >
              <NativeSelect
                value={settings.budget.mode}
                onChange={(mode) =>
                  void updateSettings({
                    budget: { ...settings.budget, mode: mode as 'auto' | 'always' | 'off' }
                  })
                }
                options={[
                  { value: 'auto', label: 'Only on API credits' },
                  { value: 'always', label: 'Always' },
                  { value: 'off', label: 'Never' }
                ]}
              />
            </Row>

            {settings.budget.mode !== 'off' && (
              <>
                <Row label="Daily cap">
                  <NumberInput
                    value={settings.budget.dailyLimitUsd}
                    step={0.25}
                    min={0.25}
                    onChange={(dailyLimitUsd) =>
                      void updateSettings({ budget: { ...settings.budget, dailyLimitUsd } })
                    }
                  />
                </Row>
                <Row label="Per-turn cap">
                  <NumberInput
                    value={settings.budget.perTurnLimitUsd}
                    step={0.05}
                    min={0.05}
                    onChange={(perTurnLimitUsd) =>
                      void updateSettings({ budget: { ...settings.budget, perTurnLimitUsd } })
                    }
                  />
                </Row>
                {budget?.enabled && (
                  <div className="mt-1.5">
                    <div className="mb-1 flex items-baseline justify-between text-[11px]">
                      <span className="text-muted-foreground">Used today</span>
                      <span className="tabular-nums text-foreground">
                        {budget.spentToday.toFixed(2)} / {budget.dailyLimitUsd.toFixed(2)}
                      </span>
                    </div>
                    <Progress
                      value={Math.min(100, (budget.spentToday / Math.max(0.01, budget.dailyLimitUsd)) * 100)}
                      tone={budget.blocked ? 'danger' : budget.spentToday / budget.dailyLimitUsd > 0.7 ? 'warning' : 'accent'}
                    />
                  </div>
                )}
              </>
            )}

            {usage?.available && (
              <div className="mt-3 flex flex-col gap-2.5 border-t border-border/60 pt-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Plan usage
                </p>
                {usage.session && <UsageRow label="Current session (5h)" bucket={usage.session} />}
                {usage.week && <UsageRow label="This week" bucket={usage.week} />}
                {usage.weekByModel
                  .filter((entry) => entry.percent > 0)
                  .map((entry) => (
                    <UsageRow
                      key={entry.model}
                      label={`This week · ${entry.model}`}
                      bucket={{ percent: entry.percent, resetsAt: null }}
                    />
                  ))}
                {usage.caveat && (
                  <p className="text-[11px] leading-relaxed text-muted-foreground text-pretty">
                    {usage.caveat}
                  </p>
                )}
              </div>
            )}

            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground text-pretty">
              The daily cap is the real guard: no turn starts once it is reached. The per-turn cap is
              passed to the CLI, which stops a turn from continuing past it — it cannot make a single
              step cheaper, so one turn can still land slightly over.
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground text-pretty">
              Neither changes how your organisation is billed. To stop credit spend outright, an
              admin has to turn off extra usage in the Anthropic Console.
            </p>
          </section>

          <Separator />

          <section>
            <SectionTitle>Background curation</SectionTitle>
            <Row label="Enabled" hint="Looks for connections while you are idle">
              <Switch
                checked={settings.curator.enabled}
                onCheckedChange={(enabled) => void updateSettings({ curator: { ...settings.curator, enabled } })}
              />
            </Row>
            <Row label="Auto-link strong matches" hint="Weak similar edges, added without asking">
              <Switch
                checked={settings.curator.autoLinkSimilar}
                onCheckedChange={(autoLinkSimilar) =>
                  void updateSettings({ curator: { ...settings.curator, autoLinkSimilar } })
                }
              />
            </Row>
            <Row label="Let the agent help" hint="At most once an hour, tags and summarises new notes">
              <Switch
                checked={settings.curator.useAgent}
                onCheckedChange={(useAgent) => void updateSettings({ curator: { ...settings.curator, useAgent } })}
              />
            </Row>
          </section>

          <Separator />

          <section>
            <SectionTitle>Graph</SectionTitle>
            <Row label="Show tags">
              <Switch
                checked={settings.graph.showTags}
                onCheckedChange={(showTags) => void updateSettings({ graph: { ...settings.graph, showTags } })}
              />
            </Row>
            <Row label="Show inferred links">
              <Switch
                checked={settings.graph.showSimilarEdges}
                onCheckedChange={(showSimilarEdges) =>
                  void updateSettings({ graph: { ...settings.graph, showSimilarEdges } })
                }
              />
            </Row>
            <Row label="Link distance">
              <RangeInput
                value={settings.graph.linkDistance}
                min={30}
                max={200}
                onChange={(linkDistance) => void updateSettings({ graph: { ...settings.graph, linkDistance } })}
              />
            </Row>
            <Row label="Repulsion">
              <RangeInput
                value={-settings.graph.charge}
                min={80}
                max={700}
                onChange={(value) => void updateSettings({ graph: { ...settings.graph, charge: -value } })}
              />
            </Row>
            <Row
              label="Name everything from"
              hint="The zoom level at which every node gets its name, not just the hubs"
            >
              <RangeInput
                value={Math.round(settings.graph.labelThreshold * 100)}
                min={20}
                max={200}
                format={(percent) => `${(percent / 100).toFixed(2)}`}
                onChange={(percent) =>
                  void updateSettings({ graph: { ...settings.graph, labelThreshold: percent / 100 } })
                }
              />
            </Row>
            <Row
              label="Turn slowly"
              hint="Hold Shift and drag, or drag with the middle button, to orbit it yourself"
            >
              <Switch
                checked={settings.graph.rotate}
                onCheckedChange={(rotate) => void updateSettings({ graph: { ...settings.graph, rotate } })}
              />
            </Row>
          </section>

          <Separator />

          <section>
            <SectionTitle>Conversation</SectionTitle>
            <Row
              label="Show the agent's steps"
              hint="Every tool call and reasoning block inline. Off shows one progress line instead."
            >
              <Switch
                checked={settings.chat.showToolActivity}
                onCheckedChange={(showToolActivity) =>
                  void updateSettings({ chat: { showToolActivity } })
                }
              />
            </Row>
          </section>

          <Separator />

          <section>
            <SectionTitle>Sound</SectionTitle>
            <Row
              label="Play a sound"
              hint="When an answer lands, a question needs you, or something fails — and only while this window has focus, since otherwise your desktop notification already makes one"
            >
              <Switch
                checked={settings.sound.enabled}
                onCheckedChange={(enabled) =>
                  void updateSettings({ sound: { ...settings.sound, enabled } })
                }
              />
            </Row>
            {settings.sound.enabled && (
              <Row label="Volume">
                <RangeInput
                  value={Math.round(settings.sound.volume * 100)}
                  min={5}
                  max={100}
                  format={(percent) => `${percent}%`}
                  onChange={(percent) =>
                    void updateSettings({ sound: { ...settings.sound, volume: percent / 100 } })
                  }
                />
              </Row>
            )}
          </section>

          <Separator />

          <section>
            <SectionTitle>Appearance</SectionTitle>
            <Row label="Dark theme">
              <Switch
                checked={settings.appearance.theme !== 'light'}
                onCheckedChange={(dark) =>
                  void updateSettings({
                    appearance: { ...settings.appearance, theme: dark ? 'dark' : 'light' }
                  })
                }
              />
            </Row>
            <Row label="Reduce motion" hint="Also follows your system setting">
              <Switch
                checked={settings.appearance.reduceMotion}
                onCheckedChange={(reduceMotion) =>
                  void updateSettings({ appearance: { ...settings.appearance, reduceMotion } })
                }
              />
            </Row>
          </section>

          {stats && (
            <>
              <Separator />
              <section>
                <SectionTitle>This brain</SectionTitle>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                  {[
                    ['Notes', stats.notes],
                    ['Connections', stats.edges],
                    ['Tags', stats.tags],
                    ['Unwritten', stats.stubs],
                    ['Orphans', stats.orphans],
                    ['Clusters', stats.clusters]
                  ].map(([label, value]) => (
                    <div key={String(label)} className="flex justify-between border-b border-border/40 pb-1">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="tabular-nums text-foreground">{value}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Second Brain {bootstrap.appVersion} · Electron {window.brain.versions.electron}
                </p>
              </section>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-[13px] text-foreground">{label}</p>
        {hint && <p className="text-[11px] leading-snug text-muted-foreground text-pretty">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function UsageRow({
  label,
  bucket
}: {
  label: string
  bucket: import('@shared/ipc').UsageBucketDto
}): React.JSX.Element {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {Math.round(bucket.percent)}%
          {bucket.resetsAt && ` · resets ${bucket.resetsAt}`}
        </span>
      </div>
      <Progress
        className="mt-1"
        value={Math.min(100, bucket.percent)}
        tone={bucket.percent >= 90 ? 'danger' : bucket.percent >= 70 ? 'warning' : 'accent'}
      />
    </div>
  )
}

function NumberInput({
  value,
  step,
  min,
  onChange
}: {
  value: number
  step: number
  min: number
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <Input
      type="number"
      value={value}
      step={step}
      min={min}
      onChange={(event) => {
        const next = Number(event.target.value)
        if (Number.isFinite(next) && next >= min) onChange(next)
      }}
      className="h-7 w-20 text-right text-[12px] tabular-nums"
    />
  )
}

/**
 * A slider that reports on release, not on every pixel.
 *
 * Each commit is an IPC round trip, a synchronous write of the whole settings file, a
 * broadcast to every window and a reheat of the force simulation. Wired straight to
 * `input`, one drag across the track fired dozens of those — which is what made the graph
 * controls feel like they were fighting the user. The number beside it still follows the
 * thumb, so the control has not become less responsive; only the work has moved to the end.
 */
function RangeInput({
  value,
  min,
  max,
  step = 1,
  format,
  onChange
}: {
  value: number
  min: number
  max: number
  step?: number
  format?: (value: number) => string
  onChange: (value: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const dragging = useRef(false)

  // Follow the outside world, but never mid-drag: the committed value arrives back through
  // this prop and would otherwise snap the thumb out from under the pointer.
  useEffect(() => {
    if (!dragging.current) setDraft(value)
  }, [value])

  const commit = (next: number): void => {
    dragging.current = false
    if (next !== value) onChange(next)
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => {
          dragging.current = true
          setDraft(Number(event.target.value))
        }}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        onPointerCancel={(event) => commit(Number(event.currentTarget.value))}
        // The keyboard path never sees a pointer event, and a setting that only responds
        // to a mouse is not reachable at all for anyone driving this from the keyboard.
        onKeyUp={(event) => commit(Number(event.currentTarget.value))}
        onBlur={(event) => commit(Number(event.currentTarget.value))}
        className="h-1 w-24 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
      />
      <span className="w-8 text-right text-[11px] tabular-nums text-muted-foreground">
        {format ? format(draft) : draft}
      </span>
    </div>
  )
}
