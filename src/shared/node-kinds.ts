import type { NodeKind } from './types'

/**
 * What a node can be, and everything that follows from it.
 *
 * One table because these five things have to agree: the type, the colour on the
 * canvas, the name in the legend, the glyph inside the circle, and the sentence the
 * agent reads when deciding. They used to live in four files and had already
 * drifted — `integration` had a colour but no legend entry, `stub` had both and no
 * longer existed.
 *
 * **Colour is the family, the icon is the kind.** Eight chart hues is the honest
 * limit for telling colours apart at 17px; sixteen would be decoration pretending
 * to be information. So kinds that belong together share a hue and are separated by
 * their glyph, and the legend groups by hue so the sharing is learnable rather than
 * arbitrary.
 */
export interface NodeKindSpec {
  id: NodeKind
  label: string
  /** CSS variable for the fill. Shared within a family. */
  token: string
  /** The family this kind belongs to, named for the legend. */
  family: string
  /** A key from NODE_ICON_PATHS. */
  icon: string
  /** When to use it, in one line. Read by the agent and shown in the legend. */
  hint: string
}

export const NODE_KINDS: NodeKindSpec[] = [
  /* ---------------------------------------------------- thinking (chart-1) */
  {
    id: 'note',
    label: 'Note',
    token: '--chart-1',
    family: 'Thinking',
    icon: 'file-text',
    hint: 'Anything written down that is not one of the more specific kinds below.'
  },
  {
    id: 'idea',
    label: 'Idea',
    token: '--chart-1',
    family: 'Thinking',
    icon: 'lightbulb',
    hint: 'A possibility, not yet acted on. Cheap to write, cheap to abandon.'
  },
  {
    id: 'question',
    label: 'Question',
    token: '--chart-1',
    family: 'Thinking',
    icon: 'circle-help',
    hint: 'Something unresolved and worth returning to. Becomes a decision when settled.'
  },

  /* ---------------------------------------------------- external (chart-2) */
  {
    id: 'source',
    label: 'Source',
    token: '--chart-2',
    family: 'External',
    icon: 'link',
    hint: 'Something someone else made: an article, a book, a talk, a repository.'
  },

  /* ------------------------------------------------------- labels (chart-3) */
  {
    id: 'tag',
    label: 'Tag',
    token: '--chart-3',
    family: 'Labels',
    icon: 'hash',
    hint: 'Created from #tags. Never written by hand — tag a note instead.'
  },
  {
    id: 'area',
    label: 'Area',
    token: '--chart-3',
    family: 'Labels',
    icon: 'layers',
    hint: 'An ongoing responsibility with no finish line: health, a client relationship, hiring.'
  },

  /* ----------------------------------------------------- outcomes (chart-4) */
  {
    id: 'project',
    label: 'Project',
    token: '--chart-4',
    family: 'Outcomes',
    icon: 'target',
    hint: 'Work with an end: it ships, or it is abandoned. Distinct from an area.'
  },
  {
    id: 'goal',
    label: 'Goal',
    token: '--chart-4',
    family: 'Outcomes',
    icon: 'flag',
    hint: 'A result being aimed at, which projects serve. Rarely more than a handful.'
  },

  /* --------------------------------------------------------- people (chart-5) */
  {
    id: 'person',
    label: 'Person',
    token: '--chart-5',
    family: 'People',
    icon: 'user',
    hint: 'Someone real. Put what you know about working with them in the body.'
  },
  {
    id: 'org',
    label: 'Organisation',
    token: '--chart-5',
    family: 'People',
    icon: 'building-2',
    hint: 'A company, client, team or institution.'
  },

  /* --------------------------------------------------------- settled (chart-6) */
  {
    id: 'task',
    label: 'Task',
    token: '--chart-6',
    family: 'Settled',
    icon: 'check',
    hint: 'One concrete thing to do. If it needs breaking down, it is a project.'
  },
  {
    id: 'decision',
    label: 'Decision',
    token: '--chart-6',
    family: 'Settled',
    icon: 'scale',
    hint: 'A call that was made and why — including what was rejected. Rarely expires.'
  },

  /* ------------------------------------------------------ moments (chart-7) */
  {
    id: 'event',
    label: 'Event',
    token: '--chart-7',
    family: 'Moments',
    icon: 'calendar',
    hint: 'Something happening at a time, before it happens.'
  },
  {
    id: 'meeting',
    label: 'Meeting',
    token: '--chart-7',
    family: 'Moments',
    icon: 'users',
    hint: 'A conversation that happened, with what was said. Its decisions belong in their own nodes.'
  },
  {
    id: 'log',
    label: 'Log',
    token: '--chart-7',
    family: 'Moments',
    icon: 'scroll-text',
    hint: 'A dated snapshot: a daily digest, a standup, a status dump. Almost always give this an expiry.'
  },

  /* -------------------------------------------------------- system (chart-8) */
  {
    id: 'integration',
    label: 'Integration',
    token: '--chart-8',
    family: 'System',
    icon: 'plug',
    hint: 'A connected service. Created by the app, not written by hand.'
  }
]

const BY_ID = new Map(NODE_KINDS.map((spec) => [spec.id, spec]))

export function kindSpec(kind: NodeKind): NodeKindSpec | undefined {
  return BY_ID.get(kind)
}

/** Every kind a note may be written as — everything except the two the app owns. */
export const AUTHORABLE_KINDS: NodeKind[] = NODE_KINDS.filter(
  (spec) => spec.id !== 'tag' && spec.id !== 'integration'
).map((spec) => spec.id)

/** Kinds accepted in frontmatter, including the legacy one that is no longer made. */
export const KNOWN_KINDS: NodeKind[] = [...NODE_KINDS.map((spec) => spec.id), 'stub']

/** Families in table order, each with its kinds. For the legend. */
export function kindFamilies(present: NodeKind[]): { family: string; kinds: NodeKindSpec[] }[] {
  const wanted = new Set(present)
  const out: { family: string; kinds: NodeKindSpec[] }[] = []

  for (const spec of NODE_KINDS) {
    if (!wanted.has(spec.id)) continue
    const last = out[out.length - 1]
    if (last && last.family === spec.family) last.kinds.push(spec)
    else out.push({ family: spec.family, kinds: [spec] })
  }

  return out
}
