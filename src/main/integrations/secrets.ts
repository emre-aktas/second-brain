import { safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../logger'

const log = createLogger('secrets')

interface StoredSecret {
  /** False when the OS keychain was unavailable and the fallback cipher was used. */
  encrypted: boolean
  value: string
  updatedAt: number
  /** When the user says the credential stops working. Null for a permanent one. */
  expiresAt?: number | null
  /**
   * Which integration the user was looking at when they entered this.
   *
   * Recorded because refs are a flat namespace: nothing stops a second manifest from declaring
   * a ref the user already filled in for a first, and such an integration reads as "ready" the
   * moment it is registered — with a credential its author never had to ask for. Knowing who it
   * was entered for is what lets that be surfaced instead of assumed.
   */
  setFor?: string | null
}

/** What is known about a secret without decrypting it. */
export interface SecretDescriptor {
  ref: string
  encrypted: boolean
  updatedAt: number
  expiresAt: number | null
  expired: boolean
  /** The integration this was entered for, when that is known. */
  setFor: string | null
}

/**
 * Credential storage for integrations.
 *
 * Values are encrypted with Electron's `safeStorage`, which is DPAPI on Windows and the
 * Keychain on macOS — so a stored credential is bound to the current OS user and needs no
 * native module. That last part matters: this app deliberately has no native toolchain in its
 * build (`node-sqlite3-wasm` over `better-sqlite3`, `npmRebuild: false`), and keytar would
 * reintroduce the ABI rebuild step that decision exists to avoid.
 *
 * **The fallback is a real cipher, not base64.** When the platform keychain is unavailable the
 * value is encrypted with AES-256-GCM under a key generated once and kept in a sibling file at
 * mode 0600. Be exact about what that buys: a process running as this user can read the key and
 * therefore the value, so it is *not* protection against an attacker on the machine. What it
 * does stop is every accidental disclosure — a synced folder, a backup, a support bundle, a
 * screen share, a grep. The previous fallback was base64, which stops none of those, and
 * `secure` stays false either way so the panel keeps saying so plainly.
 *
 * Refusing to store at all was the other option, and it is worse: it leaves the user unable to
 * connect anything, with no way forward, on the platform where they have least control.
 */
export class SecretVault {
  private secrets = new Map<string, StoredSecret>()
  private encryptionAvailable = false
  private fallbackKey: Buffer | null = null

  constructor(private file: string) {
    try {
      this.encryptionAvailable = safeStorage.isEncryptionAvailable()
    } catch {
      this.encryptionAvailable = false
    }

    if (!this.encryptionAvailable) {
      log.warn(
        'OS-backed encryption is unavailable; falling back to a local AES-256-GCM key, which ' +
          'protects against accidental disclosure but not against a process running as this user'
      )
    }

    this.load()
  }

  get secure(): boolean {
    return this.encryptionAvailable
  }

  /* ------------------------------------------------------------- the cipher */

  /** Where the fallback key lives. Beside the store, because it is useless without it. */
  private keyFile(): string {
    return join(dirname(this.file), 'secrets.key')
  }

  /**
   * The fallback key, created on first need.
   *
   * Generated rather than derived from anything about the machine: a key derived from a
   * hostname or a user id is a key anyone can recompute, which would make the fallback a
   * longer way of writing base64.
   */
  private key(): Buffer {
    if (this.fallbackKey) return this.fallbackKey

    const path = this.keyFile()
    try {
      if (existsSync(path)) {
        const stored = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
        if (stored.length === 32) {
          this.fallbackKey = stored
          return stored
        }
        log.warn('the fallback key file is malformed; generating a new one')
      }
    } catch (err) {
      log.warn('could not read the fallback key; generating a new one', err)
    }

    const fresh = randomBytes(32)
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, fresh.toString('base64'), { encoding: 'utf8', mode: 0o600 })
    } catch (err) {
      // In memory only. Values written this session then will not survive a restart, which is
      // recoverable — the user re-enters them — where losing them silently is not.
      log.error('could not persist the fallback key; secrets will not survive a restart', err)
    }
    this.fallbackKey = fresh
    return fresh
  }

  /** `iv.ciphertext.tag`, all base64. GCM so a tampered file fails loudly rather than quietly. */
  private encryptFallback(value: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv)
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return [
      iv.toString('base64'),
      body.toString('base64'),
      cipher.getAuthTag().toString('base64')
    ].join('.')
  }

  private decryptFallback(payload: string): string | undefined {
    const parts = payload.split('.')
    // A value written by the old base64 fallback has no separators. Read it rather than
    // discarding it: an upgrade must not silently disconnect what the user already connected.
    if (parts.length !== 3) return Buffer.from(payload, 'base64').toString('utf8')

    try {
      const [iv, body, tag] = parts.map((part) => Buffer.from(part, 'base64'))
      const decipher = createDecipheriv('aes-256-gcm', this.key(), iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    } catch (err) {
      log.error('a stored secret could not be decrypted with the fallback key', err)
      return undefined
    }
  }

  /* ------------------------------------------------------------------ store */

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

  set(ref: string, value: string, expiresAt?: number | null, setFor?: string | null): void {
    if (!ref) throw new Error('a secret needs a ref')
    if (!value) throw new Error('a secret needs a value')

    this.secrets.set(ref, {
      encrypted: this.encryptionAvailable,
      value: this.encryptionAvailable
        ? safeStorage.encryptString(value).toString('base64')
        : this.encryptFallback(value),
      updatedAt: Date.now(),
      expiresAt: expiresAt ?? null,
      setFor: setFor ?? null
    })
    this.persist()
  }

  get(ref: string): string | undefined {
    const entry = this.secrets.get(ref)
    if (!entry) return undefined

    try {
      if (entry.encrypted) {
        return safeStorage.decryptString(Buffer.from(entry.value, 'base64'))
      }
      return this.decryptFallback(entry.value)
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

  /** Set or clear an expiry without touching the value, so recording a rotation date is cheap. */
  setExpiry(ref: string, expiresAt: number | null): void {
    const entry = this.secrets.get(ref)
    if (!entry) throw new Error(`no secret "${ref}"`)
    this.secrets.set(ref, { ...entry, expiresAt })
    this.persist()
  }

  /** Metadata only — values leave this class through `get` and `values`, nowhere else. */
  describe(ref: string): SecretDescriptor | undefined {
    const entry = this.secrets.get(ref)
    if (!entry) return undefined
    const expiresAt = entry.expiresAt ?? null
    return {
      ref,
      encrypted: entry.encrypted,
      updatedAt: entry.updatedAt,
      expiresAt,
      expired: expiresAt !== null && expiresAt <= Date.now(),
      setFor: entry.setFor ?? null
    }
  }

  refs(): SecretDescriptor[] {
    return [...this.secrets.keys()].map((ref) => this.describe(ref)!).filter(Boolean)
  }

  /**
   * Every stored value, for the redactor and for nothing else.
   *
   * This is the one method that hands out plaintext in bulk, and it exists because redaction
   * cannot work any other way: you cannot enumerate the places a credential might turn up in
   * an error body, so the only reliable question is "does this text contain any secret I hold".
   * Undecryptable entries are skipped rather than thrown — a redactor that failed closed on one
   * bad entry would stop redacting the others.
   */
  values(): { ref: string; value: string }[] {
    const out: { ref: string; value: string }[] = []
    for (const ref of this.secrets.keys()) {
      const value = this.get(ref)
      if (value) out.push({ ref, value })
    }
    return out
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
