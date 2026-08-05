import { createContext, useContext, useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import { NodeProse } from '@/components/NodeProse'
import remarkGfm from 'remark-gfm'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { GenUiBlock, GenUiSpec, GenUiTone, GenUiTreeNode } from '@shared/genui'
import type { GraphNodeLite } from '@shared/types'
import { cn, formatNumber, resolveColor } from '@/lib/utils'
import { Badge, Card, Progress, Separator } from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * Renders an agent-authored spec.
 *
 * Nothing here evaluates code: a block type maps to a component, and anything
 * unrecognised degrades to a visible notice rather than a blank space or a crash.
 * That is what makes generated interfaces safe to hand to a model.
 */

interface GenUiContextValue {
  nodeById: Map<string, GraphNodeLite>
  onOpenNode: (id: string) => void
  onFocusNodes: (ids: string[], note?: string | null) => void
}

const GenUiContext = createContext<GenUiContextValue>({
  nodeById: new Map(),
  onOpenNode: () => {},
  onFocusNodes: () => {}
})

export interface GenUiProps {
  spec: GenUiSpec
  nodes: GraphNodeLite[]
  onOpenNode: (id: string) => void
  onFocusNodes: (ids: string[], note?: string | null) => void
  /** Spec id, which enables the pop-out-to-window control. */
  specId?: string
}

export function GenUi({
  spec,
  nodes,
  onOpenNode,
  onFocusNodes,
  specId
}: GenUiProps): React.JSX.Element {
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const compact = spec.density === 'compact'

  return (
    <GenUiContext.Provider value={{ nodeById, onOpenNode, onFocusNodes }}>
      <Card className="overflow-hidden bg-card/60">
        {(spec.title || spec.subtitle || specId) && (
          <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
            <div className="min-w-0">
              {spec.title && (
                <h3 className="text-sm font-semibold leading-tight tracking-tight text-foreground text-balance">
                  {spec.title}
                </h3>
              )}
              {spec.subtitle && (
                <p className="mt-0.5 text-[13px] text-muted-foreground text-pretty">{spec.subtitle}</p>
              )}
            </div>

            {specId && (
              <button
                type="button"
                title="Open in its own window"
                aria-label="Open in its own window"
                onClick={() =>
                  void window.brain.invoke('window:openTool', {
                    specId,
                    title: spec.title ?? 'Tool'
                  })
                }
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] hover:bg-accent hover:text-foreground active:scale-[0.94]"
              >
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
                  <path
                    d="M6.5 3.5H3.5v9h9V9.5M9.5 2.5h4v4M13 3l-5.5 5.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
          </div>
        )}
        <div className={cn('flex flex-col px-4 py-3.5', compact ? 'gap-2.5' : 'gap-4')}>
          <Blocks blocks={spec.blocks} />
        </div>
      </Card>
    </GenUiContext.Provider>
  )
}

/**
 * Inline markdown for the short text fields inside blocks.
 *
 * The agent writes `**emphasis**` in a callout or a step description as a matter
 * of habit, and rendering those as raw characters looks broken. Block-level
 * elements are unwrapped so a stray heading or list cannot break the layout of
 * whatever it is nested inside.
 */
/** A text block, with wikilinks resolved through the context's node opener. */
function ProseText({ text }: { text: string }): React.JSX.Element {
  const { onOpenNode } = useContext(GenUiContext)
  return <NodeProse onOpenNode={onOpenNode}>{text}</NodeProse>
}

function Inline({ text, className }: { text: string; className?: string }): React.JSX.Element {
  return (
    <span className={className}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        allowedElements={['p', 'strong', 'em', 'code', 'a', 'del', 'br', 'span']}
        unwrapDisallowed
        components={{
          // Keep it on one flow rather than opening a block.
          p: ({ children }) => <>{children}</>,
          code: ({ children }) => (
            <code className="rounded bg-muted-foreground/15 px-1 py-0.5 font-mono text-[0.88em]">
              {children}
            </code>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              className="text-primary underline decoration-primary/40 underline-offset-2"
              onClick={(event) => {
                event.preventDefault()
                if (href && /^https?:\/\//i.test(href)) void window.brain.invoke('app:openExternal', { url: href })
              }}
            >
              {children}
            </a>
          )
        }}
      >
        {text}
      </Markdown>
    </span>
  )
}

function Blocks({ blocks }: { blocks: GenUiBlock[] }): React.JSX.Element {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </>
  )
}

/* ------------------------------------------------------------------- tones */

const TONE_TEXT: Record<GenUiTone, string> = {
  neutral: 'text-foreground',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  accent: 'text-primary'
}

const TONE_SURFACE: Record<GenUiTone, string> = {
  neutral: 'border-border bg-secondary/45',
  info: 'border-info/25 bg-info/8',
  success: 'border-success/25 bg-success/8',
  warning: 'border-warning/30 bg-warning/10',
  danger: 'border-destructive/25 bg-destructive/8',
  accent: 'border-primary/25 bg-primary/8'
}

const CHART_FALLBACK = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7', 'chart-8']

/* ------------------------------------------------------------------ blocks */

function Block({ block }: { block: GenUiBlock }): React.JSX.Element {
  switch (block.type) {
    case 'text':
      return (
        <div
          className={cn(
            'genui-prose selectable text-[13.5px] leading-relaxed',
            block.muted ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          <ProseText text={block.text} />
        </div>
      )

    case 'heading': {
      const size = block.level === 4 ? 'text-[13px]' : block.level === 3 ? 'text-sm' : 'text-[15px]'
      return (
        <div className="flex items-baseline justify-between gap-3">
          <h4 className={cn('font-semibold tracking-tight text-foreground text-balance', size)}>
            {block.text}
          </h4>
          {block.hint && <span className="shrink-0 text-xs text-muted-foreground">{block.hint}</span>}
        </div>
      )
    }

    case 'callout':
      return (
        <div className={cn('rounded-md border px-3 py-2.5', TONE_SURFACE[block.tone ?? 'neutral'])}>
          {block.title && (
            <p className={cn('text-[13px] font-semibold', TONE_TEXT[block.tone ?? 'neutral'])}>
              {block.title}
            </p>
          )}
          <Inline
            text={block.text}
            className="block text-[13px] leading-relaxed text-foreground/90 text-pretty selectable"
          />
        </div>
      )

    case 'metrics': {
      const columns = block.columns ?? Math.min(block.items.length, 4)
      return (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {block.items.map((item, i) => (
            <div key={i} className="rounded-md border border-border/70 bg-secondary/30 px-3 py-2.5">
              {/* Not uppercased: the label is the agent's text, and CSS
                  uppercasing turns Turkish "bitti" into "BITTI". */}
              <p className="truncate text-[11px] font-medium tracking-wide text-muted-foreground">
                {item.label}
              </p>
              <p className="mt-1 flex items-baseline gap-1">
                <span className={cn('text-xl font-semibold tabular-nums leading-none', TONE_TEXT[item.tone ?? 'neutral'])}>
                  {typeof item.value === 'number' ? formatNumber(item.value) : item.value}
                </span>
                {item.unit && <span className="text-xs text-muted-foreground">{item.unit}</span>}
              </p>
              {(item.delta !== undefined || item.hint) && (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                  {item.delta !== undefined && (
                    <span
                      className={cn(
                        'font-medium tabular-nums',
                        item.trend === 'up' && 'text-success',
                        item.trend === 'down' && 'text-destructive'
                      )}
                    >
                      {item.trend === 'up' ? '↑' : item.trend === 'down' ? '↓' : ''} {item.delta}
                    </span>
                  )}
                  {item.hint && <span className="truncate">{item.hint}</span>}
                </p>
              )}
            </div>
          ))}
        </div>
      )
    }

    case 'chart':
      return <ChartBlock block={block} />

    case 'table':
      return <TableBlock block={block} />

    case 'timeline':
      return (
        <ol className="relative flex flex-col gap-3 pl-4">
          {/* A single continuous rail reads better than a segment per item. */}
          <span className="absolute bottom-1 left-[3px] top-1.5 w-px bg-border" aria-hidden="true" />
          {block.items.map((item, i) => (
            <li key={i} className="relative">
              <span
                className={cn(
                  'absolute -left-4 top-1.5 size-[7px] rounded-full ring-2 ring-card',
                  item.tone === 'success' && 'bg-success',
                  item.tone === 'warning' && 'bg-warning',
                  item.tone === 'danger' && 'bg-destructive',
                  item.tone === 'info' && 'bg-info',
                  item.tone === 'accent' && 'bg-primary',
                  (!item.tone || item.tone === 'neutral') && 'bg-muted-foreground'
                )}
                aria-hidden="true"
              />
              <div className="flex items-baseline gap-2">
                <NodeLink nodeId={item.nodeId} className="text-[13px] font-medium text-foreground">
                  {item.title}
                </NodeLink>
                {item.tag && <Badge tone="outline">{item.tag}</Badge>}
              </div>
              <p className="text-[11px] tabular-nums text-muted-foreground">{formatTs(item.ts)}</p>
              {item.text && (
                <Inline
                  text={item.text}
                  className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground text-pretty selectable"
                />
              )}
            </li>
          ))}
        </ol>
      )

    case 'steps':
      return (
        <ol className="flex flex-col gap-2.5">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-2.5">
              <span
                className={cn(
                  'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold tabular-nums',
                  item.status === 'done' && 'border-success/40 bg-success/15 text-success',
                  item.status === 'active' && 'border-primary/40 bg-primary/15 text-primary',
                  item.status === 'blocked' && 'border-destructive/40 bg-destructive/15 text-destructive',
                  (!item.status || item.status === 'todo') && 'border-border bg-secondary text-muted-foreground'
                )}
              >
                {item.status === 'done' ? '✓' : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-foreground">{item.title}</p>
                {item.text && (
                  <Inline
                    text={item.text}
                    className="block text-[13px] leading-relaxed text-muted-foreground text-pretty selectable"
                  />
                )}
              </div>
            </li>
          ))}
        </ol>
      )

    case 'compare':
      return (
        <div className="overflow-x-auto">
          <table className="w-full min-w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border">
                <th className="py-2 pr-3 text-left font-medium text-muted-foreground" />
                {block.columns.map((column, i) => (
                  <th key={i} className="px-3 py-2 text-left font-semibold text-foreground">
                    {column.title}
                    {column.hint && (
                      <span className="block text-[11px] font-normal text-muted-foreground">
                        {column.hint}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-b border-border/50 last:border-0">
                  <th className="py-2 pr-3 text-left font-medium text-muted-foreground">{row.label}</th>
                  {block.columns.map((_, columnIndex) => (
                    <td key={columnIndex} className="px-3 py-2 text-foreground tabular-nums">
                      {renderCell(row.values[columnIndex])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

    case 'tree':
      return (
        <ul className="flex flex-col gap-0.5 text-[13px]">
          {block.roots.map((root, i) => (
            <TreeNodeItem key={i} node={root} depth={0} />
          ))}
        </ul>
      )

    case 'kanban':
      return (
        <div
          className="grid gap-2 overflow-x-auto"
          style={{ gridTemplateColumns: `repeat(${block.columns.length}, minmax(11rem, 1fr))` }}
        >
          {block.columns.map((column, i) => (
            <div key={i} className="rounded-md border border-border/70 bg-secondary/25 p-2">
              <p className={cn('mb-2 px-0.5 text-[11px] font-semibold tracking-wide', TONE_TEXT[column.tone ?? 'neutral'])}>
                {column.title}
                <span className="ml-1 font-normal text-muted-foreground">{column.cards.length}</span>
              </p>
              <div className="flex flex-col gap-1.5">
                {column.cards.map((card, cardIndex) => (
                  <div key={cardIndex} className="rounded border border-border bg-card px-2 py-1.5">
                    <NodeLink nodeId={card.nodeId} className="text-[13px] font-medium text-foreground">
                      {card.title}
                    </NodeLink>
                    {card.text && (
                      <Inline
                        text={card.text}
                        className="mt-0.5 block text-[11px] leading-snug text-muted-foreground"
                      />
                    )}
                    {card.tags && card.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {card.tags.map((tag) => (
                          <Badge key={tag} tone="outline" className="px-1.5 py-0 text-[10px]">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )

    case 'nodeRefs':
      return <NodeRefsBlock ids={block.ids} layout={block.layout} showSummary={block.showSummary} />

    case 'graphFocus':
      return <GraphFocusBlock ids={block.ids} text={block.text} />

    case 'code':
      return (
        <div className="overflow-hidden rounded-md border border-border bg-secondary/40">
          {block.filename && (
            <div className="border-b border-border/70 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
              {block.filename}
            </div>
          )}
          <pre
            className={cn(
              'selectable overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground',
              block.wrap && 'whitespace-pre-wrap break-words'
            )}
          >
            <code>{block.code}</code>
          </pre>
        </div>
      )

    case 'quote':
      return (
        <blockquote className="border-l-2 border-primary/50 pl-3">
          <p className="text-[13.5px] italic leading-relaxed text-foreground/90 text-pretty selectable">
            {block.text}
          </p>
          {block.cite && (
            <footer className="mt-1 text-[11px] text-muted-foreground">
              <NodeLink nodeId={block.nodeId}>{block.cite}</NodeLink>
            </footer>
          )}
        </blockquote>
      )

    case 'progress':
      return (
        <div className="flex flex-col gap-2.5">
          {block.items.map((item, i) => {
            const max = item.max ?? 100
            const percent = max > 0 ? Math.min(100, Math.max(0, (item.value / max) * 100)) : 0
            return (
              <div key={i}>
                <div className="mb-1 flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="truncate font-medium text-foreground">{item.label}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatNumber(item.value)}
                    {item.max !== undefined && ` / ${formatNumber(max)}`}
                  </span>
                </div>
                <Progress
                  value={percent}
                  tone={item.tone === 'neutral' || !item.tone ? 'accent' : (item.tone as 'success')}
                />
                {item.hint && <p className="mt-1 text-[11px] text-muted-foreground">{item.hint}</p>}
              </div>
            )
          })}
        </div>
      )

    case 'keyValue': {
      const columns = block.columns ?? 1
      return (
        <dl
          className="grid gap-x-6 gap-y-1.5 text-[13px]"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {block.items.map((item, i) => (
            <div key={i} className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-1.5">
              <dt className="shrink-0 text-muted-foreground">{item.key}</dt>
              <dd
                className={cn(
                  'min-w-0 truncate text-right text-foreground selectable',
                  item.mono && 'font-mono text-[12px]'
                )}
              >
                {renderCell(item.value)}
              </dd>
            </div>
          ))}
        </dl>
      )
    }

    case 'badges':
      return (
        <div className="flex flex-wrap gap-1.5">
          {block.items.map((item, i) => (
            <NodeLink key={i} nodeId={item.nodeId}>
              <Badge tone={item.tone ?? 'neutral'}>
                {item.label}
                {item.count !== undefined && (
                  <span className="tabular-nums opacity-70">{item.count}</span>
                )}
              </Badge>
            </NodeLink>
          ))}
        </div>
      )

    case 'checklist':
      return (
        <ul className="flex flex-col gap-1.5">
          {block.items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-[13px]">
              <span
                className={cn(
                  'mt-[3px] grid size-[15px] shrink-0 place-items-center rounded border text-[9px]',
                  item.checked
                    ? 'border-success/45 bg-success/15 text-success'
                    : 'border-border bg-secondary'
                )}
                aria-hidden="true"
              >
                {item.checked ? '✓' : ''}
              </span>
              <div className="min-w-0">
                <Inline
                  text={item.label}
                  className={cn('text-foreground', item.checked && 'text-muted-foreground line-through')}
                />
                {item.text && (
                  <Inline text={item.text} className="block text-[12px] text-muted-foreground" />
                )}
              </div>
            </li>
          ))}
        </ul>
      )

    case 'divider':
      return block.label ? (
        <div className="flex items-center gap-2.5">
          <Separator className="flex-1" />
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
            {block.label}
          </span>
          <Separator className="flex-1" />
        </div>
      ) : (
        <Separator />
      )

    case 'section':
      return (
        <section className={cn('rounded-md border px-3 py-3', TONE_SURFACE[block.tone ?? 'neutral'])}>
          {block.title && (
            <h4 className="text-[13px] font-semibold tracking-tight text-foreground">{block.title}</h4>
          )}
          {block.subtitle && (
            <p className="mt-0.5 text-[12px] text-muted-foreground text-pretty">{block.subtitle}</p>
          )}
          <div className={cn('flex flex-col gap-3', (block.title || block.subtitle) && 'mt-2.5')}>
            <Blocks blocks={block.blocks} />
          </div>
        </section>
      )

    case 'columns': {
      const template =
        block.ratio === 'wide-left'
          ? '1.6fr 1fr'
          : block.ratio === 'wide-right'
            ? '1fr 1.6fr'
            : `repeat(${block.cols.length}, minmax(0, 1fr))`
      return (
        <div className="grid gap-4" style={{ gridTemplateColumns: template }}>
          {block.cols.map((column, i) => (
            <div key={i} className="flex min-w-0 flex-col gap-3">
              <Blocks blocks={column} />
            </div>
          ))}
        </div>
      )
    }

    case 'tabs':
      return (
        <Tabs defaultValue="0">
          <TabsList className="mb-2.5">
            {block.items.map((item, i) => (
              <TabsTrigger key={i} value={String(i)}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {block.items.map((item, i) => (
            <TabsContent key={i} value={String(i)} className="flex flex-col gap-3">
              <Blocks blocks={item.blocks} />
            </TabsContent>
          ))}
        </Tabs>
      )

    case 'accordion':
      return (
        <div className="flex flex-col gap-1">
          {block.items.map((item, i) => (
            <AccordionItem key={i} label={item.label} defaultOpen={item.defaultOpen}>
              <Blocks blocks={item.blocks} />
            </AccordionItem>
          ))}
        </div>
      )

    default:
      // Forward compatibility: a spec from a newer schema shows what it wanted
      // rather than silently rendering nothing.
      return (
        <div className="rounded-md border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground">
          Unsupported block type “{(block as { type: string }).type}”.
        </div>
      )
  }
}

/* --------------------------------------------------------------- fragments */

function AccordionItem({
  label,
  defaultOpen,
  children
}: {
  label: string
  defaultOpen?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen ?? false)

  return (
    <div className="overflow-hidden rounded-md border border-border/70">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-secondary/35 px-3 py-2 text-left text-[13px] font-medium text-foreground transition-colors duration-150 hover:bg-secondary/60"
      >
        <svg
          viewBox="0 0 12 12"
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform duration-200 ease-[var(--ease-out)]',
            open && 'rotate-90'
          )}
          aria-hidden="true"
        >
          <path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
        {label}
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3 py-3">{children}</div>
      )}
    </div>
  )
}

function TreeNodeItem({ node, depth }: { node: GenUiTreeNode; depth: number }): React.JSX.Element {
  return (
    <li>
      <div
        className="flex items-baseline gap-2 rounded px-1 py-0.5"
        style={{ paddingLeft: `${depth * 14}px` }}
      >
        <span className="text-muted-foreground/60" aria-hidden="true">
          {node.children && node.children.length > 0 ? '▾' : '·'}
        </span>
        <NodeLink nodeId={node.nodeId} className="text-foreground">
          {node.label}
        </NodeLink>
        {node.hint && <span className="text-[11px] text-muted-foreground">{node.hint}</span>}
      </div>
      {node.children && node.children.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {node.children.map((child, i) => (
            <TreeNodeItem key={i} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

function NodeLink({
  nodeId,
  children,
  className
}: {
  nodeId?: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  const { nodeById, onOpenNode } = useContext(GenUiContext)

  if (!nodeId || !nodeById.has(nodeId)) {
    return <span className={className}>{children}</span>
  }

  return (
    <button
      type="button"
      onClick={() => onOpenNode(nodeId)}
      className={cn(
        'text-left underline decoration-primary/35 decoration-1 underline-offset-2 transition-colors duration-150 hover:decoration-primary',
        className
      )}
    >
      {children}
    </button>
  )
}

function NodeRefsBlock({
  ids,
  layout = 'grid',
  showSummary
}: {
  ids: string[]
  layout?: 'grid' | 'list'
  showSummary?: boolean
}): React.JSX.Element {
  const { nodeById, onOpenNode } = useContext(GenUiContext)

  return (
    <div
      className={cn(
        layout === 'grid' ? 'grid gap-2 sm:grid-cols-2' : 'flex flex-col gap-1.5'
      )}
    >
      {ids.map((id) => {
        const node = nodeById.get(id)

        if (!node) {
          return (
            <div
              key={id}
              className="rounded-md border border-dashed border-border px-2.5 py-2 text-[12px] text-muted-foreground"
            >
              Missing node
            </div>
          )
        }

        return (
          <button
            key={id}
            type="button"
            onClick={() => onOpenNode(id)}
            className="group rounded-md border border-border bg-card px-2.5 py-2 text-left transition-[background-color,transform] duration-150 ease-[var(--ease-out)] hover:bg-accent active:scale-[0.99]"
          >
            <p className="truncate text-[13px] font-medium text-foreground">{node.title}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="tabular-nums">{node.degree} links</span>
              {node.tags.slice(0, 2).map((tag) => (
                <span key={tag} className="truncate">
                  #{tag}
                </span>
              ))}
            </p>
            {showSummary && node.tags.length === 0 && (
              <p className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">{node.kind}</p>
            )}
          </button>
        )
      })}
    </div>
  )
}

function GraphFocusBlock({ ids, text }: { ids: string[]; text?: string }): React.JSX.Element {
  const { nodeById, onFocusNodes } = useContext(GenUiContext)
  const known = ids.filter((id) => nodeById.has(id))

  return (
    <div className={cn('rounded-md border px-3 py-2.5', TONE_SURFACE.accent)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground">
            {known.length} node{known.length === 1 ? '' : 's'} in the graph
          </p>
          {text && <p className="mt-0.5 text-[12px] text-muted-foreground text-pretty">{text}</p>}
        </div>
        <Button size="xs" variant="outline" onClick={() => onFocusNodes(known, text ?? null)}>
          Show me
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {known.slice(0, 14).map((id) => (
          <Badge key={id} tone="outline" className="max-w-40 truncate">
            {nodeById.get(id)!.title}
          </Badge>
        ))}
        {known.length > 14 && <Badge tone="outline">+{known.length - 14}</Badge>}
      </div>
    </div>
  )
}

function TableBlock({
  block
}: {
  block: Extract<GenUiBlock, { type: 'table' }>
}): React.JSX.Element {
  const { nodeById, onOpenNode } = useContext(GenUiContext)

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        {block.caption && (
          <caption className="mb-1.5 text-left text-[11px] text-muted-foreground">
            {block.caption}
          </caption>
        )}
        <thead>
          <tr className="border-b border-border">
            {block.columns.map((column) => (
              <th
                key={column.key}
                style={column.width ? { width: column.width } : undefined}
                className={cn(
                  'py-1.5 pr-3 font-medium text-muted-foreground last:pr-0',
                  column.align === 'right' || column.format === 'number' ? 'text-right' : 'text-left',
                  column.align === 'center' && 'text-center'
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, i) => (
            <tr key={i} className="border-b border-border/45 last:border-0">
              {block.columns.map((column) => {
                const value = row[column.key]
                const isNumber = column.format === 'number'

                return (
                  <td
                    key={column.key}
                    className={cn(
                      'py-1.5 pr-3 text-foreground last:pr-0',
                      block.dense ? 'py-1' : 'py-1.5',
                      isNumber && 'text-right tabular-nums',
                      column.align === 'center' && 'text-center',
                      column.align === 'right' && 'text-right',
                      column.format === 'code' && 'font-mono text-[12px]'
                    )}
                  >
                    {column.format === 'badge' && value !== null && value !== undefined ? (
                      <Badge tone="outline">{String(value)}</Badge>
                    ) : column.format === 'node' && typeof value === 'string' ? (
                      nodeById.has(value) ? (
                        <button
                          type="button"
                          onClick={() => onOpenNode(value)}
                          className="text-left underline decoration-primary/35 underline-offset-2 hover:decoration-primary"
                        >
                          {nodeById.get(value)!.title}
                        </button>
                      ) : (
                        <span className="text-muted-foreground">{value}</span>
                      )
                    ) : column.format === 'date' ? (
                      <span className="tabular-nums">{formatTs(value as string | number)}</span>
                    ) : (
                      renderCell(value)
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ChartBlock({
  block
}: {
  block: Extract<GenUiBlock, { type: 'chart' }>
}): React.JSX.Element {
  const height = block.height ?? 220
  const series = block.series.map((entry, i) => ({
    ...entry,
    color: resolveColor(entry.color ?? CHART_FALLBACK[i % CHART_FALLBACK.length])
  }))

  const axisProps = {
    stroke: 'var(--muted-foreground)',
    fontSize: 11,
    tickLine: false,
    axisLine: false
  } as const

  const tooltip = (
    <ChartTooltip
      contentStyle={{
        background: 'var(--popover)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        fontSize: 12,
        color: 'var(--popover-foreground)',
        boxShadow: '0 8px 24px -8px rgb(0 0 0 / 0.35)'
      }}
      labelStyle={{ color: 'var(--muted-foreground)', fontSize: 11, marginBottom: 2 }}
      cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
    />
  )

  const grid = <CartesianGrid stroke="var(--border)" strokeOpacity={0.5} vertical={false} />
  const legend =
    block.legend !== false && series.length > 1 ? (
      <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconType="circle" iconSize={7} />
    ) : null

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {block.variant === 'pie' || block.variant === 'donut' ? (
          <PieChart>
            {tooltip}
            <Pie
              data={block.data}
              dataKey={series[0].key}
              nameKey={block.xKey}
              innerRadius={block.variant === 'donut' ? '55%' : 0}
              outerRadius="80%"
              strokeWidth={1}
              stroke="var(--card)"
            >
              {block.data.map((_, i) => (
                <Cell key={i} fill={resolveColor(CHART_FALLBACK[i % CHART_FALLBACK.length])} />
              ))}
            </Pie>
            {legend}
          </PieChart>
        ) : block.variant === 'radar' ? (
          <RadarChart data={block.data}>
            <PolarGrid stroke="var(--border)" />
            <PolarAngleAxis dataKey={block.xKey} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
            {tooltip}
            {series.map((entry) => (
              <Radar
                key={entry.key}
                dataKey={entry.key}
                name={entry.label ?? entry.key}
                stroke={entry.color}
                fill={entry.color}
                fillOpacity={0.22}
              />
            ))}
            {legend}
          </RadarChart>
        ) : block.variant === 'scatter' ? (
          <ScatterChart>
            {grid}
            <XAxis dataKey={block.xKey} {...axisProps} />
            <YAxis {...axisProps} label={yLabel(block.yLabel)} />
            {tooltip}
            {series.map((entry) => (
              <Scatter
                key={entry.key}
                dataKey={entry.key}
                name={entry.label ?? entry.key}
                data={block.data}
                fill={entry.color}
              />
            ))}
            {legend}
          </ScatterChart>
        ) : block.variant === 'area' ? (
          <AreaChart data={block.data}>
            {grid}
            <XAxis dataKey={block.xKey} {...axisProps} />
            <YAxis {...axisProps} label={yLabel(block.yLabel)} />
            {tooltip}
            {series.map((entry) => (
              <Area
                key={entry.key}
                type={block.smooth === false ? 'linear' : 'monotone'}
                dataKey={entry.key}
                name={entry.label ?? entry.key}
                stroke={entry.color}
                fill={entry.color}
                fillOpacity={0.18}
                strokeWidth={2}
                stackId={block.stacked ? 'stack' : undefined}
                dot={false}
              />
            ))}
            {legend}
          </AreaChart>
        ) : block.variant === 'bar' || block.variant === 'hbar' ? (
          <BarChart data={block.data} layout={block.variant === 'hbar' ? 'vertical' : 'horizontal'}>
            {grid}
            {block.variant === 'hbar' ? (
              <>
                <XAxis type="number" {...axisProps} />
                <YAxis type="category" dataKey={block.xKey} width={110} {...axisProps} />
              </>
            ) : (
              <>
                <XAxis dataKey={block.xKey} {...axisProps} />
                <YAxis {...axisProps} label={yLabel(block.yLabel)} />
              </>
            )}
            {tooltip}
            {series.map((entry) => (
              <Bar
                key={entry.key}
                dataKey={entry.key}
                name={entry.label ?? entry.key}
                fill={entry.color}
                radius={block.variant === 'hbar' ? [0, 3, 3, 0] : [3, 3, 0, 0]}
                stackId={block.stacked ? 'stack' : undefined}
                maxBarSize={38}
              />
            ))}
            {legend}
          </BarChart>
        ) : (
          <LineChart data={block.data}>
            {grid}
            <XAxis dataKey={block.xKey} {...axisProps} />
            <YAxis {...axisProps} label={yLabel(block.yLabel)} />
            {tooltip}
            {series.map((entry) => (
              <Line
                key={entry.key}
                type={block.smooth === false ? 'linear' : 'monotone'}
                dataKey={entry.key}
                name={entry.label ?? entry.key}
                stroke={entry.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3.5, strokeWidth: 0 }}
              />
            ))}
            {legend}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

function yLabel(label: string | undefined): object | undefined {
  if (!label) return undefined
  return {
    value: label,
    angle: -90,
    position: 'insideLeft',
    style: { fill: 'var(--muted-foreground)', fontSize: 11 }
  }
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return formatNumber(value)
  return String(value)
}

function formatTs(ts: string | number): string {
  const ms = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!Number.isFinite(ms)) return String(ts)

  return new Date(ms).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}
