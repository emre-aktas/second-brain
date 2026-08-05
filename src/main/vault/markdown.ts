import matter from 'gray-matter'
import type { NodeKind } from '@shared/types'
import { KNOWN_KINDS } from '@shared/node-kinds'

export interface WikiLink {
  target: string
  heading?: string
  alias?: string
}

export interface ParsedNote {
  /** Present only if the file carries an explicit id in its frontmatter. */
  id?: string
  title: string
  kind: NodeKind
  tags: string[]
  links: WikiLink[]
  summary?: string
  created?: number
  updated?: number
  /** When this note stops being worth keeping. Absent means permanent. */
  expires?: number
  /** Markdown body with the frontmatter block removed. */
  body: string
  /** Every frontmatter key, including ones we do not interpret. */
  frontmatter: Record<string, unknown>
}


// Fenced blocks and inline code are removed before extraction so a wikilink or
// #tag shown as an example inside a code sample does not create real edges.
const FENCED_BACKTICK = new RegExp('```[\\s\\S]*?```', 'g')
const FENCED_TILDE = new RegExp('~~~[\\s\\S]*?~~~', 'g')
const INLINE_CODE = new RegExp('`[^`\\n]*`', 'g')

// [[Target#heading|alias]] — all three parts optional except the target.
const WIKILINK = new RegExp('\\[\\[([^\\[\\]|#]+)(?:#([^\\[\\]|]+))?(?:\\|([^\\[\\]]+))?\\]\\]', 'g')

// #tag, but not a markdown heading (which has a space after #) and not a URL
// fragment (which is preceded by a non-space character).
const INLINE_TAG = new RegExp('(^|[\\s(])#([\\p{L}][\\p{L}\\p{N}_/-]*)', 'gu')

function stripCode(markdown: string): string {
  return markdown
    .replace(FENCED_BACKTICK, ' ')
    .replace(FENCED_TILDE, ' ')
    .replace(INLINE_CODE, ' ')
}

export function extractWikiLinks(markdown: string): WikiLink[] {
  const text = stripCode(markdown)
  const seen = new Set<string>()
  const links: WikiLink[] = []

  for (const match of text.matchAll(WIKILINK)) {
    const target = match[1]?.trim()
    if (!target) continue

    const heading = match[2]?.trim()
    const alias = match[3]?.trim()
    const key = `${target.toLowerCase()}#${heading ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)

    links.push({
      target,
      ...(heading ? { heading } : {}),
      ...(alias ? { alias } : {})
    })
  }

  return links
}

export function extractInlineTags(markdown: string): string[] {
  const text = stripCode(markdown)
  const tags = new Set<string>()

  for (const match of text.matchAll(INLINE_TAG)) {
    const tag = match[2]?.trim()
    // A bare number is almost always an issue reference, not a tag.
    if (tag && !/^\d+$/.test(tag)) tags.add(tag)
  }

  return [...tags]
}

function normaliseTags(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((t) => String(t).trim().replace(/^#/, ''))
      .filter((t) => t.length > 0 && t.length <= 64)
  }
  if (typeof input === 'string') {
    return input
      .split(',')
      .map((t) => t.trim().replace(/^#/, ''))
      .filter((t) => t.length > 0)
  }
  return []
}

function parseDate(input: unknown): number | undefined {
  if (input === null || input === undefined) return undefined
  if (input instanceof Date) {
    const ms = input.getTime()
    return Number.isFinite(ms) ? ms : undefined
  }
  if (typeof input === 'number') return input > 1e12 ? input : input * 1000
  if (typeof input === 'string') {
    const ms = Date.parse(input)
    return Number.isNaN(ms) ? undefined : ms
  }
  return undefined
}

/** First meaningful line of prose, used when no explicit summary is set. */
export function deriveSummary(body: string, maxLength = 220): string {
  const text = stripCode(body)
    .replace(WIKILINK, (_m, target: string, _h: string, alias: string) => alias || target)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('>'))

  if (!text) return ''
  const clean = text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1).trimEnd()}…` : clean
}

export function parseNote(raw: string, fallbackTitle: string): ParsedNote {
  let data: Record<string, unknown> = {}
  let body = raw

  try {
    const parsed = matter(raw)
    data = (parsed.data ?? {}) as Record<string, unknown>
    body = parsed.content
  } catch {
    // Malformed YAML must not make a note unreadable — treat the whole file as body.
    body = raw.replace(/^---[\s\S]*?---\r?\n?/, '')
  }

  const rawKind = typeof data['kind'] === 'string' ? (data['kind'] as string) : 'note'
  const kind = (KNOWN_KINDS as string[]).includes(rawKind) ? (rawKind as NodeKind) : 'note'

  const frontmatterTags = normaliseTags(data['tags'])
  const inlineTags = extractInlineTags(body)
  const tags = [...new Set([...frontmatterTags, ...inlineTags])]

  const title =
    (typeof data['title'] === 'string' && data['title'].trim()) ||
    firstHeading(body) ||
    fallbackTitle

  return {
    ...(typeof data['id'] === 'string' ? { id: data['id'] } : {}),
    title,
    kind,
    tags,
    links: extractWikiLinks(body),
    ...(typeof data['summary'] === 'string' ? { summary: data['summary'] } : {}),
    ...(parseDate(data['created']) !== undefined ? { created: parseDate(data['created'])! } : {}),
    ...(parseDate(data['updated']) !== undefined ? { updated: parseDate(data['updated'])! } : {}),
    // In the file rather than only in the index: a note that stops being useful
    // next Tuesday should say so in its own frontmatter, editable in Obsidian and
    // surviving a rebuild of the index.
    ...(parseDate(data['expires']) !== undefined ? { expires: parseDate(data['expires'])! } : {}),
    body,
    frontmatter: data
  }
}

function firstHeading(body: string): string | undefined {
  const match = body.match(/^#{1,3}\s+(.+)$/m)
  return match?.[1]?.trim()
}

export interface SerializeInput {
  title: string
  body: string
  kind?: NodeKind
  tags?: string[]
  summary?: string | null
  created?: number
  updated?: number
  /** When this note stops being worth keeping. Null or absent means it is permanent. */
  expires?: number | null
  /** Extra frontmatter keys to preserve verbatim. */
  extra?: Record<string, unknown>
}

const MANAGED_KEYS = new Set([
  'title',
  'kind',
  'tags',
  'summary',
  'created',
  'updated',
  'expires'
])

/**
 * Write frontmatter in a stable key order so re-saving a note produces a minimal
 * diff — important once the vault is under git.
 */
export function serializeNote(input: SerializeInput): string {
  const data: Record<string, unknown> = { title: input.title }

  if (input.kind && input.kind !== 'note') data['kind'] = input.kind
  if (input.tags?.length) data['tags'] = input.tags
  if (input.summary) data['summary'] = input.summary
  if (input.created) data['created'] = new Date(input.created).toISOString()
  data['updated'] = new Date(input.updated ?? Date.now()).toISOString()
  if (input.expires) data['expires'] = new Date(input.expires).toISOString()

  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (MANAGED_KEYS.has(key)) continue
    data[key] = value
  }

  const body = input.body.replace(/^\s+/, '')
  return matter.stringify(`${body.trimEnd()}\n`, data)
}
