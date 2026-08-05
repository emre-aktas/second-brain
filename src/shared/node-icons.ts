import type { GraphNodeLite, NodeKind } from './types'
import { NODE_KINDS } from './node-kinds'

/**
 * A glyph inside each node's circle.
 *
 * A field of coloured dots tells you how connected things are and nothing about
 * what they are — the colour legend has to be learned, and at a glance it reads as
 * decoration. An icon says "this is a person", "this is a book", "this is money"
 * before you have read a single label.
 *
 * Chosen by looking at the node rather than by asking the agent, so it works on a
 * vault written entirely by hand, in any language: the kind decides the fallback,
 * and a tag or a word in the title overrides it when it says something more
 * specific. Turkish and English keywords both, because this user writes in both.
 */

/**
 * The fallback for each kind, from the kind table.
 *
 * A stub gets nothing: it is drawn as a hollow circle, and a glyph would give a
 * note nobody has written more presence than it deserves.
 */
const BY_KIND: Record<NodeKind, string | null> = {
  ...(Object.fromEntries(NODE_KINDS.map((spec) => [spec.id, spec.icon])) as Record<
    NodeKind,
    string
  >),
  stub: null
}

/**
 * Subject keywords, most specific first.
 *
 * Matched against tags and then against words in the title. Accents are folded, so
 * "sağlık" matches "saglik" — the same folding the search index uses.
 */
const BY_SUBJECT: { icon: string; words: string[] }[] = [
  { icon: 'lightbulb', words: ['idea', 'ideas', 'fikir', 'fikirler', 'brainstorm'] },
  { icon: 'book-open', words: ['book', 'books', 'kitap', 'reading', 'okuma', 'okudum'] },
  { icon: 'code', words: ['code', 'kod', 'dev', 'programming', 'yazilim', 'bug', 'api', 'refactor'] },
  { icon: 'wallet', words: ['money', 'para', 'finance', 'finans', 'budget', 'butce', 'invoice', 'fatura'] },
  { icon: 'heart-pulse', words: ['health', 'saglik', 'doctor', 'doktor', 'medical', 'ilac'] },
  { icon: 'dumbbell', words: ['workout', 'gym', 'spor', 'antrenman', 'fitness', 'exercise'] },
  { icon: 'plane', words: ['travel', 'seyahat', 'trip', 'gezi', 'tatil', 'holiday', 'flight', 'ucus'] },
  { icon: 'music', words: ['music', 'muzik', 'song', 'sarki', 'album', 'playlist'] },
  { icon: 'film', words: ['film', 'movie', 'dizi', 'series', 'cinema', 'sinema', 'watch'] },
  { icon: 'utensils', words: ['recipe', 'tarif', 'food', 'yemek', 'cooking', 'mutfak', 'restaurant'] },
  { icon: 'users', words: ['meeting', 'toplanti', 'standup', 'interview', 'gorusme', 'team', 'ekip'] },
  { icon: 'palette', words: ['design', 'tasarim', 'ui', 'ux', 'brand', 'marka', 'figma'] },
  { icon: 'graduation-cap', words: ['learning', 'ogrenme', 'course', 'kurs', 'study', 'ders', 'school', 'okul'] },
  { icon: 'briefcase', words: ['work', 'is', 'client', 'musteri', 'job', 'career', 'kariyer'] },
  { icon: 'house', words: ['home', 'ev', 'house', 'apartment', 'kira', 'rent'] },
  { icon: 'mail', words: ['email', 'eposta', 'mail', 'newsletter', 'bulten'] },
  { icon: 'message-square', words: ['chat', 'slack', 'sohbet', 'message', 'mesaj', 'dm'] },
  { icon: 'map-pin', words: ['place', 'yer', 'location', 'konum', 'city', 'sehir', 'address'] },
  { icon: 'flask-conical', words: ['experiment', 'deney', 'research', 'arastirma', 'hypothesis', 'test'] },
  { icon: 'sprout', words: ['habit', 'aliskanlik', 'growth', 'gelisim', 'routine', 'rutin'] },
  { icon: 'gamepad-2', words: ['game', 'oyun', 'gaming'] },
  { icon: 'camera', words: ['photo', 'fotograf', 'foto', 'shoot', 'cekim'] },
  { icon: 'car', words: ['car', 'araba', 'arac', 'drive', 'vehicle'] },
  { icon: 'gift', words: ['gift', 'hediye', 'birthday', 'dogum'] },
  { icon: 'scale', words: ['law', 'hukuk', 'legal', 'contract', 'sozlesme'] },
  { icon: 'shield', words: ['security', 'guvenlik', 'privacy', 'gizlilik', 'password', 'sifre'] },
  { icon: 'wrench', words: ['fix', 'tamir', 'maintenance', 'bakim', 'tool', 'arac-kutusu'] },
  { icon: 'trending-up', words: ['metric', 'metrik', 'growth', 'analytics', 'revenue', 'gelir', 'sales'] },
  { icon: 'clock', words: ['deadline', 'termin', 'schedule', 'takvim', 'time', 'zaman', 'reminder'] },
  { icon: 'bookmark', words: ['bookmark', 'kaydet', 'saved', 'later', 'sonra', 'link'] },
  { icon: 'quote', words: ['quote', 'alinti', 'excerpt', 'passage'] },
  { icon: 'globe', words: ['web', 'website', 'site', 'internet', 'url'] },
  { icon: 'building-2', words: ['company', 'sirket', 'office', 'ofis', 'org', 'kurum'] },
  { icon: 'leaf', words: ['nature', 'doga', 'plant', 'bitki', 'garden', 'bahce', 'environment'] },
  { icon: 'sparkles', words: ['ai', 'agent', 'llm', 'prompt', 'claude', 'gpt'] }
]

/** Same folding rules as the search index, so keywords match how people type. */
function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ıİ]/g, 'i')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[üÜ]/g, 'u')
    .replace(/[şŞ]/g, 's')
    .replace(/[öÖ]/g, 'o')
    .replace(/[çÇ]/g, 'c')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

/**
 * Two indexes, because Turkish is agglutinative.
 *
 * "tarif" has to match "tarifi" and "tarifler", "seyahat" has to match
 * "seyahatte" — so a long keyword matches as a prefix. Short ones must not: "ev"
 * would then match "evet" and "is" would match "İstanbul", so those match whole
 * words only.
 */
const MIN_PREFIX = 4

const SUBJECT_EXACT = new Map<string, string>()
const SUBJECT_PREFIXES: { word: string; icon: string }[] = []
for (const entry of BY_SUBJECT) {
  for (const word of entry.words) {
    if (!SUBJECT_EXACT.has(word)) SUBJECT_EXACT.set(word, entry.icon)
    if (word.length >= MIN_PREFIX) SUBJECT_PREFIXES.push({ word, icon: entry.icon })
  }
}
// Longest first, so "kitap" wins over a shorter keyword that also fits.
SUBJECT_PREFIXES.sort((a, b) => b.word.length - a.word.length)

function subjectFor(word: string): string | undefined {
  const exact = SUBJECT_EXACT.get(word)
  if (exact) return exact
  if (word.length < MIN_PREFIX) return undefined
  return SUBJECT_PREFIXES.find((entry) => word.startsWith(entry.word))?.icon
}

const cache = new Map<string, string | null>()

export function iconForNode(node: GraphNodeLite): string | null {
  const key = `${node.kind}|${node.tags.join(',')}|${node.title}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const resolved = resolveIcon(node)
  // Bounded: a large vault must not turn this into a leak.
  if (cache.size > 5000) cache.clear()
  cache.set(key, resolved)
  return resolved
}

/**
 * Kinds whose icon may be overridden by what the node is about.
 *
 * Only the two that say nothing specific. Filing something as a `decision`, a `log`
 * or an `integration` is a deliberate statement about what it is, and a keyword in
 * the title does not outrank it — a decision about code is still a decision. A
 * `note` has no such claim, so its subject is the most informative thing available,
 * and a tag's title *is* its subject.
 */
const SUBJECT_OVERRIDABLE = new Set<NodeKind>(['note', 'tag'])

function resolveIcon(node: GraphNodeLite): string | null {
  if (node.kind === 'stub') return null

  if (SUBJECT_OVERRIDABLE.has(node.kind)) {
    // A tag says what something is about more deliberately than its title does, so
    // it is checked first.
    for (const tag of node.tags) {
      const icon = subjectFor(fold(tag))
      if (icon) return icon
    }

    for (const word of fold(node.title).split(/[^a-z0-9]+/)) {
      if (word.length < 2) continue
      const icon = subjectFor(word)
      if (icon) return icon
    }
  }

  return BY_KIND[node.kind] ?? 'file-text'
}
