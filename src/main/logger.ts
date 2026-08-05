import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_BYTES = 4 * 1024 * 1024

let logPath: string | null = null
let minLevel: Level = process.env['NODE_ENV'] === 'development' ? 'debug' : 'info'

/**
 * A tail kept in memory as well as on disk.
 *
 * The file is the record; this is what the log window shows, live. Diagnosing "the
 * tool did nothing" from a file the user has to find, open, and refresh is not a
 * diagnosis — it has to be one click away while the thing is still happening.
 */
export interface LogEntry {
  seq: number
  ts: number
  level: Level
  scope: string
  message: string
  extra?: string
}

const MAX_ENTRIES = 1500
const entries: LogEntry[] = []
let seq = 0
let onEntry: ((entry: LogEntry) => void) | null = null

/** Called by the bootstrap so new lines reach open log windows. */
export function onLogEntry(listener: (entry: LogEntry) => void): void {
  onEntry = listener
}

export function logTail(limit = MAX_ENTRIES): LogEntry[] {
  return limit >= entries.length ? [...entries] : entries.slice(entries.length - limit)
}

export function clearLogTail(): void {
  entries.length = 0
}

export function initLogger(file: string, level?: Level): void {
  logPath = file
  if (level) minLevel = level
  try {
    mkdirSync(dirname(file), { recursive: true })
    rotateIfNeeded()
  } catch {
    logPath = null
  }
}

function rotateIfNeeded(): void {
  if (!logPath) return
  try {
    if (existsSync(logPath) && statSync(logPath).size > MAX_BYTES) {
      renameSync(logPath, `${logPath}.1`)
    }
  } catch {
    /* rotation is best-effort */
  }
}

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return

  const now = Date.now()
  const ts = new Date(now).toISOString()
  const rendered = extra === undefined ? undefined : safeStringify(extra)
  let line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`
  if (rendered !== undefined) {
    line += ` ${rendered}`
  }

  const entry: LogEntry = { seq: ++seq, ts: now, level, scope, message, extra: rendered }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  try {
    onEntry?.(entry)
  } catch {
    /* a listener must never be able to break logging */
  }

  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleFn(line)

  if (logPath) {
    try {
      appendFileSync(logPath, `${line}\n`, 'utf8')
    } catch {
      /* never let logging break the app */
    }
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void
  info(message: string, extra?: unknown): void
  warn(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
  child(sub: string): Logger
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
    child: (sub) => createLogger(`${scope}:${sub}`)
  }
}

export const log = createLogger('app')
