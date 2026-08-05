/**
 * Generated UI — the contract between the agent and the renderer.
 *
 * The agent never writes JSX. It emits a spec that validates against the schema
 * below, and the renderer maps every block onto a shadcn/ui component. That keeps
 * generated interfaces safe (no eval, no runtime compilation), fast, and always
 * consistent with the design system.
 *
 * Validation lives here so the main process can reject a malformed spec and hand
 * the agent a precise error to self-correct against.
 */

import { z } from 'zod'

/* ------------------------------------------------------------------ shared */

/** A chart-1..chart-8 design token, a semantic name, or any raw CSS color. */
const Color = z.string().max(64)

const Align = z.enum(['left', 'center', 'right'])

const Tone = z.enum(['neutral', 'info', 'success', 'warning', 'danger', 'accent'])

const Trend = z.enum(['up', 'down', 'flat'])

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])

/* ------------------------------------------------------------------ blocks */

const TextBlock = z.object({
  type: z.literal('text'),
  /** GitHub-flavoured markdown. Inline [[wikilinks]] resolve to brain nodes. */
  text: z.string(),
  muted: z.boolean().optional()
})

const HeadingBlock = z.object({
  type: z.literal('heading'),
  text: z.string(),
  level: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  hint: z.string().optional()
})

const CalloutBlock = z.object({
  type: z.literal('callout'),
  tone: Tone.optional(),
  title: z.string().optional(),
  text: z.string(),
  icon: z.string().optional()
})

const MetricsBlock = z.object({
  type: z.literal('metrics'),
  items: z
    .array(
      z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
        unit: z.string().optional(),
        delta: z.union([z.string(), z.number()]).optional(),
        trend: Trend.optional(),
        hint: z.string().optional(),
        tone: Tone.optional()
      })
    )
    .min(1)
    .max(8),
  columns: z.number().int().min(1).max(4).optional()
})

const ChartBlock = z.object({
  type: z.literal('chart'),
  variant: z.enum(['line', 'area', 'bar', 'hbar', 'pie', 'donut', 'radar', 'scatter']),
  /** Row-oriented records: [{ month: "Jan", reads: 12, writes: 4 }, ...] */
  data: z.array(z.record(z.string(), Scalar)).min(1),
  xKey: z.string(),
  series: z
    .array(
      z.object({
        key: z.string(),
        label: z.string().optional(),
        color: Color.optional()
      })
    )
    .min(1)
    .max(8),
  stacked: z.boolean().optional(),
  smooth: z.boolean().optional(),
  height: z.number().int().min(120).max(560).optional(),
  yLabel: z.string().optional(),
  legend: z.boolean().optional()
})

const TableBlock = z.object({
  type: z.literal('table'),
  columns: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        align: Align.optional(),
        /** `number` right-aligns and uses tabular figures. */
        format: z.enum(['text', 'number', 'date', 'badge', 'code', 'node']).optional(),
        width: z.string().optional()
      })
    )
    .min(1)
    .max(12),
  rows: z.array(z.record(z.string(), Scalar)).max(500),
  caption: z.string().optional(),
  dense: z.boolean().optional()
})

const TimelineBlock = z.object({
  type: z.literal('timeline'),
  items: z
    .array(
      z.object({
        /** ISO string or epoch millis. */
        ts: z.union([z.string(), z.number()]),
        title: z.string(),
        text: z.string().optional(),
        tag: z.string().optional(),
        tone: Tone.optional(),
        nodeId: z.string().optional()
      })
    )
    .min(1)
    .max(200)
})

const StepsBlock = z.object({
  type: z.literal('steps'),
  items: z
    .array(
      z.object({
        title: z.string(),
        text: z.string().optional(),
        status: z.enum(['done', 'active', 'todo', 'blocked']).optional()
      })
    )
    .min(1)
    .max(24)
})

const CompareBlock = z.object({
  type: z.literal('compare'),
  columns: z.array(z.object({ title: z.string(), hint: z.string().optional() })).min(2).max(4),
  rows: z
    .array(
      z.object({
        label: z.string(),
        /** One entry per column, in order. */
        values: z.array(z.union([z.string(), z.number(), z.boolean()]))
      })
    )
    .min(1)
    .max(40)
})

type TreeNodeShape = {
  label: string
  hint?: string
  nodeId?: string
  children?: TreeNodeShape[]
}

const TreeNode: z.ZodType<TreeNodeShape> = z.lazy(() =>
  z.object({
    label: z.string(),
    hint: z.string().optional(),
    nodeId: z.string().optional(),
    children: z.array(TreeNode).optional()
  })
)

const TreeBlock = z.object({
  type: z.literal('tree'),
  roots: z.array(TreeNode).min(1).max(40)
})

const KanbanBlock = z.object({
  type: z.literal('kanban'),
  columns: z
    .array(
      z.object({
        title: z.string(),
        tone: Tone.optional(),
        cards: z
          .array(
            z.object({
              title: z.string(),
              text: z.string().optional(),
              tags: z.array(z.string()).max(6).optional(),
              nodeId: z.string().optional()
            })
          )
          .max(40)
      })
    )
    .min(1)
    .max(5)
})

const NodeRefsBlock = z.object({
  type: z.literal('nodeRefs'),
  /** Brain node ids. Unknown ids render as a dimmed "missing" card. */
  ids: z.array(z.string()).min(1).max(60),
  layout: z.enum(['grid', 'list']).optional(),
  showSummary: z.boolean().optional()
})

const GraphFocusBlock = z.object({
  type: z.literal('graphFocus'),
  ids: z.array(z.string()).min(1).max(200),
  text: z.string().optional(),
  /** Also drive the main graph canvas to this selection. */
  driveMainGraph: z.boolean().optional(),
  depth: z.number().int().min(0).max(3).optional()
})

const CodeBlock = z.object({
  type: z.literal('code'),
  code: z.string().max(20000),
  lang: z.string().max(24).optional(),
  filename: z.string().optional(),
  wrap: z.boolean().optional()
})

const QuoteBlock = z.object({
  type: z.literal('quote'),
  text: z.string(),
  cite: z.string().optional(),
  nodeId: z.string().optional()
})

const ProgressBlock = z.object({
  type: z.literal('progress'),
  items: z
    .array(
      z.object({
        label: z.string(),
        value: z.number(),
        max: z.number().optional(),
        tone: Tone.optional(),
        hint: z.string().optional()
      })
    )
    .min(1)
    .max(12)
})

const KeyValueBlock = z.object({
  type: z.literal('keyValue'),
  items: z
    .array(
      z.object({
        key: z.string(),
        value: z.union([z.string(), z.number(), z.boolean()]),
        mono: z.boolean().optional()
      })
    )
    .min(1)
    .max(40),
  columns: z.number().int().min(1).max(3).optional()
})

const BadgesBlock = z.object({
  type: z.literal('badges'),
  items: z
    .array(
      z.object({
        label: z.string(),
        tone: Tone.optional(),
        count: z.number().optional(),
        nodeId: z.string().optional()
      })
    )
    .min(1)
    .max(60)
})

const ChecklistBlock = z.object({
  type: z.literal('checklist'),
  items: z
    .array(
      z.object({
        label: z.string(),
        checked: z.boolean().optional(),
        text: z.string().optional()
      })
    )
    .min(1)
    .max(60)
})

const DividerBlock = z.object({
  type: z.literal('divider'),
  label: z.string().optional()
})

/* ------------------------------------------------------- container blocks */

type BlockShape = Record<string, unknown>

const AnyBlock: z.ZodType<BlockShape> = z.lazy(() =>
  z.discriminatedUnion('type', [
    TextBlock,
    HeadingBlock,
    CalloutBlock,
    MetricsBlock,
    ChartBlock,
    TableBlock,
    TimelineBlock,
    StepsBlock,
    CompareBlock,
    TreeBlock,
    KanbanBlock,
    NodeRefsBlock,
    GraphFocusBlock,
    CodeBlock,
    QuoteBlock,
    ProgressBlock,
    KeyValueBlock,
    BadgesBlock,
    ChecklistBlock,
    DividerBlock,
    TabsBlock,
    ColumnsBlock,
    AccordionBlock,
    SectionBlock
  ])
) as z.ZodType<BlockShape>

const TabsBlock = z.object({
  type: z.literal('tabs'),
  items: z
    .array(z.object({ label: z.string(), blocks: z.array(AnyBlock).min(1).max(30) }))
    .min(2)
    .max(6)
})

const ColumnsBlock = z.object({
  type: z.literal('columns'),
  cols: z.array(z.array(AnyBlock).min(1).max(20)).min(2).max(3),
  ratio: z.enum(['equal', 'wide-left', 'wide-right']).optional()
})

const AccordionBlock = z.object({
  type: z.literal('accordion'),
  items: z
    .array(
      z.object({
        label: z.string(),
        blocks: z.array(AnyBlock).min(1).max(30),
        defaultOpen: z.boolean().optional()
      })
    )
    .min(1)
    .max(20)
})

const SectionBlock = z.object({
  type: z.literal('section'),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  tone: Tone.optional(),
  blocks: z.array(AnyBlock).min(1).max(40)
})

/* -------------------------------------------------------------------- spec */

export const GenUiSpecSchema = z.object({
  title: z.string().max(160).optional(),
  subtitle: z.string().max(400).optional(),
  density: z.enum(['compact', 'normal']).optional(),
  blocks: z.array(AnyBlock).min(1).max(60)
})

/* The zod schema is the runtime authority. Because the recursive container blocks
 * go through `z.lazy` + a cast, `z.infer` would collapse them to Record<string,
 * unknown> — so the renderer-facing types are written out explicitly below and
 * `validateGenUiSpec` bridges the two. */

export interface GenUiSpec {
  title?: string
  subtitle?: string
  density?: 'compact' | 'normal'
  blocks: GenUiBlock[]
}

export type GenUiTone = z.infer<typeof Tone>
export type GenUiBlock =
  | z.infer<typeof TextBlock>
  | z.infer<typeof HeadingBlock>
  | z.infer<typeof CalloutBlock>
  | z.infer<typeof MetricsBlock>
  | z.infer<typeof ChartBlock>
  | z.infer<typeof TableBlock>
  | z.infer<typeof TimelineBlock>
  | z.infer<typeof StepsBlock>
  | z.infer<typeof CompareBlock>
  | z.infer<typeof TreeBlock>
  | z.infer<typeof KanbanBlock>
  | z.infer<typeof NodeRefsBlock>
  | z.infer<typeof GraphFocusBlock>
  | z.infer<typeof CodeBlock>
  | z.infer<typeof QuoteBlock>
  | z.infer<typeof ProgressBlock>
  | z.infer<typeof KeyValueBlock>
  | z.infer<typeof BadgesBlock>
  | z.infer<typeof ChecklistBlock>
  | z.infer<typeof DividerBlock>
  | { type: 'tabs'; items: { label: string; blocks: GenUiBlock[] }[] }
  | { type: 'columns'; cols: GenUiBlock[][]; ratio?: 'equal' | 'wide-left' | 'wide-right' }
  | {
      type: 'accordion'
      items: { label: string; blocks: GenUiBlock[]; defaultOpen?: boolean }[]
    }
  | {
      type: 'section'
      title?: string
      subtitle?: string
      tone?: GenUiTone
      blocks: GenUiBlock[]
    }

export type GenUiTreeNode = TreeNodeShape

export interface GenUiRecord {
  id: string
  sessionId: string
  messageId: string | null
  spec: GenUiSpec
  createdAt: number
}

/* ---------------------------------------------------------------- helpers */

export interface GenUiValidation {
  ok: boolean
  spec?: GenUiSpec
  errors?: string[]
}

/** Validate an untrusted spec and return agent-readable error strings. */
export function validateGenUiSpec(input: unknown): GenUiValidation {
  const parsed = GenUiSpecSchema.safeParse(input)
  if (parsed.success) return { ok: true, spec: parsed.data as unknown as GenUiSpec }

  const errors = parsed.error.issues.slice(0, 25).map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
  return { ok: false, errors }
}

export const GENUI_BLOCK_TYPES = [
  'text',
  'heading',
  'callout',
  'metrics',
  'chart',
  'table',
  'timeline',
  'steps',
  'compare',
  'tree',
  'kanban',
  'nodeRefs',
  'graphFocus',
  'code',
  'quote',
  'progress',
  'keyValue',
  'badges',
  'checklist',
  'divider',
  'tabs',
  'columns',
  'accordion',
  'section'
] as const
