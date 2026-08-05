import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from '../logger'

const log = createLogger('secrets')

interface StoredSecret {
  /** False when the OS keychain was unavailable and the value is only obfuscated. */
  encrypted: boolean
  value: string
  updatedAt: number
}

/**
 * Credential storage for integrations.
 *
 * Values are encrypted with Electron's safeStorage, which is backed by DPAPI on
 * Windows, so they are bound to the current OS user. If the platform keychain is
 * unavailable the value is still stored — refusing would leave the user unable to
 * connect anything — but it is marked unencrypted so the UI can say so plainly
 * rather than implying protection that is not there.
 *
 * Secrets never appear in manifests, in the agent's context, or in logs.
 */
export class SecretVault {
  private secrets = new Map<string, StoredSecret>()
  private encryptionAvailable = false

  constructor(private file: string) {
    try {
      this.encryptionAvailable = safeStorage.isEncryptionAvailable()
    } catch {
      this.encryptionAvailable = false
    }

    if (!this.encryptionAvailable) {
      log.warn('OS-backed encryption is unavailable; stored credentials will be obfuscated only')
    }

    this.load()
  }

  get secure(): boolean {
    return this.encryptionAvailable
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, StoredSecret>
      for (const [ref, entry] of Object.entries(raw)) this.secrets.set(ref, entry)
    } catch (err) {
      log.error('secret store unreadable; starting empty', err)
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.secrets), null, 2), {
        encoding: 'utf8',
        mode: 0o600
      })
    } catch (err) {
      log.error('could not write secret store', err)
    }
  }

  set(ref: string, value: string): void {
    if (!ref) throw new Error('a secret needs a ref')

    if (this.encryptionAvailable) {
      this.secrets.set(ref, {
        encrypted: true,
        value: safeStorage.encryptString(value).toString('base64'),
        updatedAt: Date.now()
      })
    } else {
      this.secrets.set(ref, {
        encrypted: false,
        value: Buffer.from(value, 'utf8').toString('base64'),
        updatedAt: Date.now()
      })
    }
    this.persist()
  }

  get(ref: string): string | undefined {
    const entry = this.secrets.get(ref)
    if (!entry) return undefined

    try {
      if (entry.encrypted) {
        return safeStorage.decryptString(Buffer.from(entry.value, 'base64'))
      }
      return Buffer.from(entry.value, 'base64').toString('utf8')
    } catch (err) {
      log.error(`could not decrypt secret "${ref}"`, err)
      return undefined
    }
  }

  setJson(ref: string, value: unknown): void {
    this.set(ref, JSON.stringify(value))
  }

  getJson<T>(ref: string): T | undefined {
    const raw = this.get(ref)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  has(ref: string): boolean {
    return this.secrets.has(ref)
  }

  delete(ref: string): void {
    this.secrets.delete(ref)
    this.persist()
  }

  /** Refs only — values never leave this class except through get(). */
  refs(): { ref: string; encrypted: boolean; updatedAt: number }[] {
    return [...this.secrets.entries()].map(([ref, entry]) => ({
      ref,
      encrypted: entry.encrypted,
      updatedAt: entry.updatedAt
    }))
  }

  /** Remove every secret belonging to an integration. */
  deleteByPrefix(prefix: string): number {
    let removed = 0
    for (const ref of [...this.secrets.keys()]) {
      if (ref.startsWith(prefix)) {
        this.secrets.delete(ref)
        removed++
      }
    }
    if (removed) this.persist()
    return removed
  }
}
