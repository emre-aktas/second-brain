import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Resolve a design-token colour name (chart-1..8, primary, …) to a CSS value. */
export function resolveColor(input: string | undefined, fallback = 'var(--chart-1)'): string {
  if (!input) return fallback
  if (/^(chart-[1-8]|primary|success|warning|info|destructive|muted-foreground|foreground)$/.test(input)) {
    return `var(--${input})`
  }
  return input
}

export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts
  const abs = Math.abs(diff)
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour

  if (abs < 45_000) return 'just now'
  if (abs < hour) {
    const n = Math.round(abs / min)
    return diff > 0 ? `${n}m ago` : `in ${n}m`
  }
  if (abs < day) {
    const n = Math.round(abs / hour)
    return diff > 0 ? `${n}h ago` : `in ${n}h`
  }
  if (abs < 7 * day) {
    const n = Math.round(abs / day)
    return diff > 0 ? `${n}d ago` : `in ${n}d`
  }
  return new Date(ts).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: new Date(ts).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric'
  })
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

export function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}
