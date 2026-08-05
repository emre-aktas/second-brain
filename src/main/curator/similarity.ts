import { titleKey } from '../util/slug'

/**
 * TF-IDF similarity over note bodies.
 *
 * Deliberately not embeddings: this runs locally on every idle pass, needs no
 * model, no network and no API spend, and for a personal vault the signal that
 * matters — two notes sharing unusual vocabulary — is exactly what TF-IDF finds.
 * Embeddings would add cost and a moving part for a marginal gain here.
 */

// Combined English/Turkish stop list. Frequent words carry no signal about which
// two notes belong together, and dropping them keeps the inverted index small.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had', 'was', 'were', 'are',
  'you', 'your', 'not', 'but', 'they', 'their', 'them', 'there', 'then', 'than', 'what', 'when',
  'which', 'while', 'who', 'will', 'would', 'could', 'should', 'about', 'into', 'over', 'some',
  'more', 'most', 'other', 'such', 'only', 'also', 'been', 'being', 'because', 'after', 'before',
  'can', 'just', 'like', 'make', 'made', 'many', 'much', 'each', 'how', 'why', 'its', 'his', 'her',
  've', 'bir', 'bu', 'sey', 'icin', 'ile', 'ama', 'veya', 'gibi', 'daha', 'cok', 'kadar', 'sonra',
  'once', 'olarak', 'oldu', 'olan', 'var', 'yok', 'ise', 'ki', 'de', 'da', 'mi', 'ne', 'her',
  'hic', 'ben', 'sen', 'biz', 'siz', 'onlar', 'bunu', 'sunu', 'sadece', 'ayni', 'diye', 'ozellikle'
])

const MIN_TERM_LENGTH = 3
const MAX_TERMS_PER_DOC = 400

export interface Doc {
  id: string
  title: string
  body: string
}

export interface SimilarPair {
  a: string
  b: string
  score: number
  /** Distinctive terms the two notes share, for explaining the suggestion. */
  sharedTerms: string[]
}

function tokenize(text: string): string[] {
  return titleKey(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TERM_LENGTH && !STOPWORDS.has(token) && !/^\d+$/.test(token))
}

interface Vector {
  id: string
  /** term -> tf-idf weight, L2-normalised. */
  weights: Map<string, number>
}

export class SimilarityIndex {
  private vectors: Vector[] = []
  private documentFrequency = new Map<string, number>()
  private postings = new Map<string, string[]>()
  private byId = new Map<string, Vector>()

  constructor(docs: Doc[]) {
    this.build(docs)
  }

  private build(docs: Doc[]): void {
    const termCounts: { id: string; counts: Map<string, number>; total: number }[] = []

    for (const doc of docs) {
      // The title is worth more than a body mention, so it is weighted by
      // counting its terms three times.
      const tokens = [...tokenize(doc.title), ...tokenize(doc.title), ...tokenize(doc.title), ...tokenize(doc.body)]
      if (tokens.length === 0) continue

      const counts = new Map<string, number>()
      for (const token of tokens.slice(0, MAX_TERMS_PER_DOC * 4)) {
        counts.set(token, (counts.get(token) ?? 0) + 1)
      }

      termCounts.push({ id: doc.id, counts, total: tokens.length })
      for (const term of counts.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1)
      }
    }

    const docCount = termCounts.length || 1

    for (const entry of termCounts) {
      const weights = new Map<string, number>()
      let norm = 0

      for (const [term, count] of entry.counts) {
        const df = this.documentFrequency.get(term) ?? 1
        // A term in every note tells us nothing; smoothed idf pushes it to ~0.
        const idf = Math.log((docCount + 1) / (df + 0.5))
        if (idf <= 0) continue

        const weight = (count / entry.total) * idf
        weights.set(term, weight)
        norm += weight * weight
      }

      if (norm === 0) continue
      const scale = 1 / Math.sqrt(norm)
      for (const [term, weight] of weights) weights.set(term, weight * scale)

      // Keep the strongest terms only; the tail contributes noise and cost.
      const trimmed = new Map(
        [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TERMS_PER_DOC)
      )

      const vector: Vector = { id: entry.id, weights: trimmed }
      this.vectors.push(vector)
      this.byId.set(entry.id, vector)

      for (const term of trimmed.keys()) {
        const list = this.postings.get(term)
        if (list) list.push(entry.id)
        else this.postings.set(term, [entry.id])
      }
    }
  }

  get size(): number {
    return this.vectors.length
  }

  private cosine(a: Vector, b: Vector): number {
    // Iterate the smaller vector; both are L2-normalised so the dot product is
    // already the cosine.
    const [small, large] = a.weights.size <= b.weights.size ? [a, b] : [b, a]
    let dot = 0
    for (const [term, weight] of small.weights) {
      const other = large.weights.get(term)
      if (other !== undefined) dot += weight * other
    }
    return dot
  }

  private sharedTerms(a: Vector, b: Vector, limit = 5): string[] {
    const shared: { term: string; weight: number }[] = []
    for (const [term, weight] of a.weights) {
      const other = b.weights.get(term)
      if (other !== undefined) shared.push({ term, weight: weight * other })
    }
    return shared
      .sort((x, y) => y.weight - x.weight)
      .slice(0, limit)
      .map((s) => s.term)
  }

  /**
   * Pairs above `threshold`.
   *
   * Candidates come from the inverted index rather than from comparing all
   * n² pairs: two notes can only score highly if they share a term, and terms
   * that appear nearly everywhere are skipped since they generate huge candidate
   * sets while contributing almost no score.
   */
  findPairs(threshold: number, maxPairs = 200): SimilarPair[] {
    const commonTermCutoff = Math.max(8, Math.ceil(this.vectors.length * 0.25))
    const candidates = new Set<string>()

    for (const [, ids] of this.postings) {
      if (ids.length < 2 || ids.length > commonTermCutoff) continue
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          candidates.add(ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`)
        }
      }
      // Guard against a pathological vault producing millions of candidates.
      if (candidates.size > 400_000) break
    }

    const pairs: SimilarPair[] = []
    for (const key of candidates) {
      const [aId, bId] = key.split('|')
      const a = this.byId.get(aId)
      const b = this.byId.get(bId)
      if (!a || !b) continue

      const score = this.cosine(a, b)
      if (score < threshold) continue
      pairs.push({ a: aId, b: bId, score, sharedTerms: this.sharedTerms(a, b) })
    }

    return pairs.sort((x, y) => y.score - x.score).slice(0, maxPairs)
  }

  /** Notes most similar to one specific note. */
  neighbours(id: string, limit = 8): SimilarPair[] {
    const target = this.byId.get(id)
    if (!target) return []

    const scored: SimilarPair[] = []
    for (const vector of this.vectors) {
      if (vector.id === id) continue
      const score = this.cosine(target, vector)
      if (score <= 0) continue
      scored.push({ a: id, b: vector.id, score, sharedTerms: this.sharedTerms(target, vector) })
    }

    return scored.sort((x, y) => y.score - x.score).slice(0, limit)
  }
}

/** Titles that differ only by punctuation, case or a trailing number. */
export function findNearDuplicateTitles(
  docs: { id: string; title: string }[]
): { a: string; b: string; title: string }[] {
  const buckets = new Map<string, { id: string; title: string }[]>()

  for (const doc of docs) {
    const key = titleKey(doc.title)
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+\d+$/, '')
      .trim()
    if (!key) continue
    const list = buckets.get(key)
    if (list) list.push(doc)
    else buckets.set(key, [doc])
  }

  const out: { a: string; b: string; title: string }[] = []
  for (const [, group] of buckets) {
    if (group.length < 2) continue
    for (let i = 1; i < group.length; i++) {
      out.push({ a: group[0].id, b: group[i].id, title: group[0].title })
    }
  }
  return out
}
