import { Database as WasmDatabase } from 'node-sqlite3-wasm'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from '../logger'

const log = createLogger('db')

export type SqlValue = string | number | boolean | null | Uint8Array
export type SqlParams = SqlValue[] | Record<string, SqlValue>

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

/**
 * Thin synchronous wrapper over node-sqlite3-wasm.
 *
 * SQLite is compiled to WebAssembly here rather than linked as a native addon:
 * it removes the Electron ABI rebuild step entirely, so dev and packaged builds
 * run byte-identical engines. The surface below matches better-sqlite3 closely
 * enough that swapping the driver later touches only this file.
 */
export class Db {
  private db: WasmDatabase
  private savepointDepth = 0
  readonly file: string

  constructor(file: string) {
    this.file = file
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new WasmDatabase(file)

    // WAL keeps the curator's background writes from blocking UI reads.
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('PRAGMA synchronous = NORMAL')
    this.db.run('PRAGMA foreign_keys = ON')
    this.db.run('PRAGMA busy_timeout = 5000')
  }

  run(sql: string, params?: SqlParams): RunResult {
    const res = this.db.run(sql, params as never)
    return { changes: res.changes, lastInsertRowid: Number(res.lastInsertRowid) }
  }

  get<T>(sql: string, params?: SqlParams): T | undefined {
    const row = this.db.get(sql, params as never)
    return (row ?? undefined) as T | undefined
  }

  all<T>(sql: string, params?: SqlParams): T[] {
    return this.db.all(sql, params as never) as unknown as T[]
  }

  /** Multi-statement DDL. */
  exec(sql: string): void {
    this.db.exec(sql)
  }

  pluck<T extends SqlValue>(sql: string, params?: SqlParams): T | undefined {
    const row = this.db.get(sql, params as never)
    if (!row) return undefined
    const values = Object.values(row)
    return values.length ? (values[0] as T) : undefined
  }

  /**
   * Run `fn` atomically. Nested calls use SAVEPOINTs so composed repository
   * methods can each declare a transaction without fighting each other.
   */
  transaction<T>(fn: () => T): T {
    const depth = this.savepointDepth
    const name = `sp_${depth}`

    if (depth === 0) this.db.run('BEGIN IMMEDIATE')
    else this.db.run(`SAVEPOINT ${name}`)
    this.savepointDepth = depth + 1

    try {
      const result = fn()
      this.savepointDepth = depth
      if (depth === 0) this.db.run('COMMIT')
      else this.db.run(`RELEASE ${name}`)
      return result
    } catch (err) {
      this.savepointDepth = depth
      try {
        if (depth === 0) this.db.run('ROLLBACK')
        else this.db.run(`ROLLBACK TO ${name}`)
      } catch (rollbackErr) {
        log.error('rollback failed', rollbackErr)
      }
      throw err
    }
  }

  /** Reclaim space and rebuild indexes; safe to call on a schedule. */
  optimize(): void {
    try {
      this.db.run('PRAGMA optimize')
      this.db.run("INSERT INTO nodes_fts(nodes_fts) VALUES ('optimize')")
    } catch (err) {
      log.warn('optimize failed', err)
    }
  }

  checkpoint(): void {
    try {
      this.db.run('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* best effort */
    }
  }

  get isOpen(): boolean {
    return this.db.isOpen
  }

  close(): void {
    if (!this.db.isOpen) return
    this.checkpoint()
    this.db.close()
  }
}
