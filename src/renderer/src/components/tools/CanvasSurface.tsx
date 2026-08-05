import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import type {
  ChecklistState,
  GenUiToneName,
  KanbanState,
  TableState,
  ToolNode
} from '@shared/types'
import { asText, interpolate, readPath, writePath } from '@shared/bindings'
import { cn } from '@/lib/utils'
import { Badge, NativeSelect, Spinner, Switch } from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { toolIcon } from '@/components/panels/ToolsPanel'
import { ChecklistSurface, KanbanSurface, TableSurface } from './surfaces'

/**
 * Renders a tool's layout tree.
 *
 * This is the blank canvas: the agent decides the shape of the document and the
 * interface over it, and every node that reads or writes does so through a dot
 * path into that one document. Nothing here is evaluated — an unknown node type
 * degrades to a visible notice rather than breaking the tool.
 */

export interface CanvasProps {
  layout: ToolNode[]
  state: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  onAction: (actionId: string) => void
  runningAction: string | null
}

const TONE_SURFACE: Record<GenUiToneName, string> = {
  neutral: 'border-border bg-secondary/35',
  info: 'border-info/25 bg-info/8',
  success: 'border-success/25 bg-success/8',
  warning: 'border-warning/30 bg-warning/10',
  danger: 'border-destructive/25 bg-destructive/8',
  accent: 'border-primary/25 bg-primary/8'
}

const TONE_TEXT: Record<GenUiToneName, string> = {
  neutral: 'text-foreground',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  accent: 'text-primary'
}

/* ------------------------------------------------------------------ canvas */

export function CanvasSurface(props: CanvasProps): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      {props.layout.map((node, index) => (
        <Node key={index} node={node} {...props} />
      ))}
    </div>
  )
}

function Node({
  node,
  state,
  onChange,
  onAction,
  runningAction,
  layout
}: { node: ToolNode } & CanvasProps): React.JSX.Element {
  const set = (path: string, value: unknown): void => onChange(writePath(state, path, value))
  const kids = (children: ToolNode[]): React.JSX.Element[] =>
    children.map((child, index) => (
      <Node
        key={index}
        node={child}
        layout={layout}
        state={state}
        onChange={onChange}
        onAction={onAction}
        runningAction={runningAction}
      />
    ))

  switch (node.type) {
    case 'stack':
      return (
        <div
          className={cn(
            'flex min-w-0',
            node.direction === 'row' ? 'flex-row' : 'flex-col',
            node.wrap && 'flex-wrap',
            node.grow && 'min-h-0 flex-1',
            node.scroll && 'overflow-auto',
            node.align === 'center' && 'items-center',
            node.align === 'end' && 'items-end',
            node.align === 'stretch' && 'items-stretch',
            node.justify === 'center' && 'justify-center',
            node.justify === 'end' && 'justify-end',
            node.justify === 'between' && 'justify-between'
          )}
          style={{ gap: `${node.gap ?? 8}px` }}
        >
          {kids(node.children)}
        </div>
      )

    case 'grid': {
      // A wrapping flex row rather than a real grid, so `columns` is what fits
      // when there is room and cells drop to the next row when there is not. A
      // fixed grid squeezed three results into 190px each in a narrow window;
      // tool windows get resized, so reflowing is the right default.
      const columns = Math.max(1, Math.min(6, node.columns))
      const gap = node.gap ?? 8
      const minWidth = node.minItemWidth ?? 240

      return (
        <div
          className={cn('flex min-w-0 flex-wrap', node.grow && 'min-h-0 flex-1')}
          style={{ gap: `${gap}px` }}
        >
          {kids(node.children).map((child, index) => (
            <div
              key={index}
              className="flex min-w-0 flex-col"
              style={{
                flex: `1 1 calc((100% - ${(columns - 1) * gap}px) / ${columns})`,
                minWidth: `min(100%, ${minWidth}px)`
              }}
            >
              {child}
            </div>
          ))}
        </div>
      )
    }

    case 'panel':
      return (
        <section
          className={cn(
            'flex min-w-0 flex-col rounded-lg border px-3 py-2.5',
            TONE_SURFACE[node.tone ?? 'neutral'],
            node.grow && 'min-h-0 flex-1',
            node.scroll && 'overflow-auto'
          )}
        >
          {node.title && (
            // Not uppercased: these strings are the agent's and the user's, and
            // CSS uppercasing turns Turkish "istiyorsun" into "ISTIYORSUN".
            <p className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
              {interpolate(node.title, state)}
            </p>
          )}
          <div className={cn('flex min-w-0 flex-col gap-2', node.grow && 'min-h-0 flex-1')}>
            {kids(node.children)}
          </div>
        </section>
      )

    case 'tabs':
      return <TabsNode node={node} kids={kids} state={state} />

    case 'divider':
      return node.label ? (
        <div className="flex items-center gap-2.5">
          <span className="h-px flex-1 bg-border" />
          <span className="text-[11px] tracking-wide text-muted-foreground">
            {interpolate(node.label, state)}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : (
        <span className="h-px w-full bg-border" />
      )

    case 'spacer':
      return <span style={{ height: `${node.size ?? 8}px` }} aria-hidden="true" />

    case 'heading': {
      const size = node.level === 3 ? 'text-[13px]' : node.level === 2 ? 'text-sm' : 'text-[15px]'
      // The hint sits beside the title rather than at the far edge: across a wide
      // canvas the gap grows until the two read as unrelated.
      return (
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <h3 className={cn('font-semibold tracking-tight text-foreground text-balance', size)}>
            {interpolate(node.value, state)}
          </h3>
          {node.hint && (
            <span className="text-[11px] text-muted-foreground">
              {interpolate(node.hint, state)}
            </span>
          )}
        </div>
      )
    }

    case 'text':
      return (
        <p
          className={cn(
            'leading-relaxed text-pretty selectable',
            node.size === 'lg' ? 'text-[14px]' : node.size === 'sm' ? 'text-[12px]' : 'text-[13px]',
            node.muted ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {interpolate(node.value, state)}
        </p>
      )

    case 'badge':
      return (
        <span>
          <Badge tone={node.tone ?? 'neutral'}>{interpolate(node.value, state)}</Badge>
        </span>
      )

    case 'note':
      return (
        <p
          className={cn(
            'rounded-md border px-2.5 py-1.5 text-[12px] leading-relaxed text-pretty',
            TONE_SURFACE[node.tone ?? 'info'],
            TONE_TEXT[node.tone ?? 'info']
          )}
        >
          {interpolate(node.value, state)}
        </p>
      )

    case 'input':
      return (
        <div className={cn('flex min-w-0 flex-col', node.grow && 'min-h-0 flex-1')}>
          {node.label && (
            <label className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground">
              {node.label}
            </label>
          )}
          {node.multiline ? (
            <Textarea
              value={asText(readPath(state, node.bind))}
              placeholder={node.placeholder}
              onChange={(event) => set(node.bind, event.target.value)}
              rows={node.rows ?? 4}
              className={cn('text-[13.5px]', node.grow && 'min-h-0 flex-1')}
            />
          ) : (
            <Input
              value={asText(readPath(state, node.bind))}
              placeholder={node.placeholder}
              onChange={(event) => set(node.bind, event.target.value)}
              className="text-[13.5px]"
            />
          )}
        </div>
      )

    case 'select': {
      // Falling back to the first option means a fresh tool shows a real choice
      // rather than an empty control the user has to discover.
      const stored = asText(readPath(state, node.bind))
      const value = node.options.some((option) => option.value === stored)
        ? stored
        : (node.options[0]?.value ?? '')
      return (
        <div className="flex items-center justify-between gap-2">
          {node.label && <span className="text-[12px] text-muted-foreground">{node.label}</span>}
          <NativeSelect
            aria-label={node.label || undefined}
            value={value}
            onChange={(next) => set(node.bind, next)}
            options={node.options}
          />
        </div>
      )
    }

    case 'toggle':
      return (
        <div className="flex items-center justify-between gap-2">
          {node.label && <span className="text-[12px] text-foreground">{node.label}</span>}
          <Switch
            aria-label={node.label || undefined}
            checked={readPath(state, node.bind) === true}
            onCheckedChange={(checked) => set(node.bind, checked)}
          />
        </div>
      )

    case 'slider': {
      const raw = Number(readPath(state, node.bind))
      const value = Number.isFinite(raw) ? raw : (node.min ?? 0)
      return (
        <div className="flex items-center justify-between gap-2">
          {node.label && <span className="text-[12px] text-muted-foreground">{node.label}</span>}
          <span className="flex items-center gap-2">
            <input
              type="range"
              aria-label={node.label || undefined}
              min={node.min ?? 0}
              max={node.max ?? 100}
              step={node.step ?? 1}
              value={value}
              onChange={(event) => set(node.bind, Number(event.target.value))}
              className="h-1 w-28 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
            />
            <span className="w-8 text-right text-[11px] tabular-nums text-muted-foreground">
              {value}
            </span>
          </span>
        </div>
      )
    }

    case 'button': {
      const Icon = toolIcon(node.icon ?? null)
      const isRunning = runningAction === node.action
      return (
        <Button
          size="sm"
          variant={node.variant === 'ghost' ? 'ghost' : node.variant === 'outline' ? 'outline' : 'default'}
          disabled={runningAction !== null}
          onClick={() => onAction(node.action)}
          className={cn(node.grow && 'flex-1')}
        >
          {isRunning ? <Spinner className="size-3.5" /> : <Icon className="size-3.5" />}
          {node.label}
        </Button>
      )
    }

    case 'output':
      return <OutputNode node={node} state={state} runningAction={runningAction} />

    case 'kanban':
      return (
        <div className={cn('min-w-0', node.grow && 'min-h-0 flex-1')}>
          <KanbanSurface
            state={(readPath(state, node.bind) as KanbanState) ?? { columns: [] }}
            onChange={(next) => set(node.bind, next)}
          />
        </div>
      )

    case 'table':
      return (
        <div className={cn('min-w-0', node.grow && 'min-h-0 flex-1')}>
          <TableSurface
            state={(readPath(state, node.bind) as TableState) ?? { columns: [], rows: [] }}
            onChange={(next) => set(node.bind, next)}
          />
        </div>
      )

    case 'checklist':
      return (
        <div className={cn('min-w-0', node.grow && 'min-h-0 flex-1')}>
          <ChecklistSurface
            state={(readPath(state, node.bind) as ChecklistState) ?? { items: [] }}
            onChange={(next) => set(node.bind, next)}
          />
        </div>
      )

    default:
      return (
        <p className="rounded-md border border-dashed border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
          Unsupported element “{(node as { type: string }).type}”.
        </p>
      )
  }
}

function TabsNode({
  node,
  kids,
  state
}: {
  node: Extract<ToolNode, { type: 'tabs' }>
  kids: (children: ToolNode[]) => React.JSX.Element[]
  state: Record<string, unknown>
}): React.JSX.Element {
  const [active, setActive] = useState(0)
  const children = node.items[active]?.children ?? []

  // A pane that wants to fill the height cannot unless the tabs do too. Rather
  // than making that the author's problem at every level, grow when the visible
  // pane holds something that grows.
  const grows =
    node.grow ?? children.some((child) => 'grow' in child && child.grow === true)

  return (
    <div className={cn('flex min-w-0 flex-col', grows && 'min-h-0 flex-1')}>
      <div className="mb-2 inline-flex h-8 w-fit shrink-0 items-center gap-0.5 rounded-lg bg-secondary/70 p-0.5">
        {node.items.map((item, index) => (
          <button
            key={index}
            type="button"
            onClick={() => setActive(index)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors duration-150',
              index === active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {interpolate(item.label, state)}
          </button>
        ))}
      </div>
      <div className={cn('flex min-w-0 flex-col gap-2', grows && 'min-h-0 flex-1')}>
        {kids(children)}
      </div>
    </div>
  )
}

/**
 * One result.
 *
 * The per-block copy button is the point: three results side by side each need
 * their own. It sits inside the pane rather than in a header row above it, because
 * three panes in a grid put a right-aligned header control against the next
 * column's edge — near enough to its neighbour's label to read as that one's.
 */
function OutputNode({
  node,
  state,
  runningAction
}: {
  node: Extract<ToolNode, { type: 'output' }>
  state: Record<string, unknown>
  runningAction: string | null
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const value = asText(readPath(state, node.bind))
  /**
   * A run is going and this pane still holds the previous answer.
   *
   * The old text is worth keeping on screen — it is what the user is comparing
   * against — but not as though it were the result of the button they just pressed.
   * Left undimmed with no spinner, a pane that already had content gave no sign
   * anything was happening, which is exactly "did it freeze?".
   */
  const stale = runningAction !== null && value.length > 0
  // Copying while a new answer is on its way copies the old one.
  const showCopy = node.copy !== false && value.length > 0 && !stale

  return (
    <div className={cn('flex min-w-0 flex-col', node.grow && 'min-h-0 flex-1')}>
      {node.label && (
        <span className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground">
          {interpolate(node.label, state)}
        </span>
      )}

      <div
        className={cn(
          'relative overflow-auto rounded-md border border-border bg-secondary/25 px-3 py-2.5',
          node.grow && 'min-h-0 flex-1',
          showCopy && 'pr-9'
        )}
        style={node.minHeight ? { minHeight: `${node.minHeight}px` } : undefined}
      >
        {showCopy && (
          <button
            type="button"
            aria-label={node.label ? `Copy ${node.label}` : 'Copy'}
            title="Copy"
            onClick={() => {
              void navigator.clipboard.writeText(value)
              setCopied(true)
              setTimeout(() => setCopied(false), 1400)
            }}
            className={cn(
              'absolute right-1.5 top-1.5 z-10 grid size-6 place-items-center rounded',
              'bg-background/80 text-muted-foreground backdrop-blur-sm',
              'transition-[color,transform] duration-150 ease-[var(--ease-out)]',
              'hover:text-foreground active:scale-90'
            )}
          >
            {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          </button>
        )}

        {stale && (
          <p className="mb-1.5 flex items-center gap-2 text-[12px] text-muted-foreground">
            <Spinner className="size-3.5" />
            Working — showing the previous answer
          </p>
        )}

        {value ? (
          <div
            className={cn(
              'transition-opacity duration-200 ease-[var(--ease-out)]',
              stale && 'opacity-45'
            )}
          >
            {node.markdown === false ? (
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground selectable">
                {value}
              </p>
            ) : (
              <div className="genui-prose selectable text-[13.5px] leading-relaxed text-foreground">
                <Markdown remarkPlugins={[remarkGfm]}>{value}</Markdown>
              </div>
            )}
          </div>
        ) : runningAction ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Spinner className="size-3.5" />
            Working…
          </p>
        ) : (
          <p className="text-[13px] text-muted-foreground">{node.placeholder ?? 'Nothing yet.'}</p>
        )}
      </div>
    </div>
  )
}
