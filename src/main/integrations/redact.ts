/**
 * Keeping secret values out of everything that leaves the main process.
 *
 * The rule this file exists to enforce: a value the user typed into the vault must never reach
 * the agent, the chat transcript, or the app log. Every other guard in this area is a matter of
 * *not putting* a secret somewhere; this one is the backstop for the places it arrives without
 * anyone deciding to put it there, and there are three of them.
 *
 * **The error body.** A failing authenticated request answers with a body, and that body is
 * handed to the agent to explain the failure. Plenty of APIs echo the offending credential
 * back — in a `WWW-Authenticate` challenge, in a validation error naming the bad token, in a
 * debug envelope that repeats the request. This is the likeliest leak in the whole app, because
 * it only happens on the unhappy path and the unhappy path is the one nobody screenshots.
 *
 * **The URL.** `apiKey` auth with `in: 'query'` puts the value in the query string, and a URL
 * reaches an error message from several directions — a fetch failure, a redirect log, an
 * exception's `cause`.
 *
 * **Derived forms.** `basic` auth base64-encodes the stored value before sending it, so
 * scanning for the value alone would sail straight past the header actually on the wire.
 * Anything that transforms a secret has to have its transform registered here or the redaction
 * is theatre.
 */

/** A value to look for, with the ref to name in its place. */
export interface SecretOccurrence {
  ref: string
  value: string
}

/**
 * Below this length a "secret" is not redactable.
 *
 * Not a security judgement about the token — a practical one about substring replacement. A
 * four-character value occurs inside ordinary English, inside JSON keys and inside base64, so
 * redacting it would corrupt unrelated text while giving no protection worth having. Real
 * credentials are far longer than this; anything shorter is reported as unredactable rather
 * than silently ignored, which is what `unredactable` is for.
 */
const MIN_REDACTABLE = 8

/**
 * Every form a secret can appear in on the wire.
 *
 * The base64 forms are why this exists as a function rather than a single string compare: the
 * stored value and the transmitted header are different strings for `basic` auth, and a
 * redactor that only knows the first one is worse than none, because it reports success.
 */
export function secretForms(value: string): string[] {
  /*
   * Gated on the *original* value's length, not each form's.
   *
   * base64 of a four-character value is eight characters, which would sail past a per-form
   * length check and be used as a search pattern — with exactly the unreliability the check
   * exists to prevent, and now on a string the reader cannot recognise. A value too short to
   * redact is too short in every encoding of it.
   */
  if (value.length < MIN_REDACTABLE) return []

  const forms = new Set<string>([value])

  // `basic` sends base64(value), and the value is already `user:pass`.
  forms.add(Buffer.from(value, 'utf8').toString('base64'))
  // A URL-encoded query parameter, for `apiKey` with `in: 'query'`.
  const encoded = encodeURIComponent(value)
  if (encoded !== value) forms.add(encoded)

  return [...forms]
}

/**
 * Replace every occurrence of every known secret with a name for it.
 *
 * The replacement keeps the ref, because the reader — the agent, or whoever is reading the log
 * — needs to know *which* credential was involved to be told anything useful about the
 * failure. "[redacted: figma_pat]" is actionable; a row of asterisks is not.
 *
 * Pure, and exported for the probe: this is the one function whose correctness is the whole
 * feature, and it must be assertable without a network, a vault, or an Electron app object.
 */
export function redactWith(text: string, secrets: SecretOccurrence[]): string {
  if (!text) return text

  let out = text
  for (const secret of secrets) {
    for (const form of secretForms(secret.value)) {
      // Split/join rather than a regex: a credential can contain any byte, and building a
      // pattern out of one means escaping it correctly every time or leaking on the miss.
      if (out.includes(form)) out = out.split(form).join(`[redacted: ${secret.ref}]`)
    }
  }
  return out
}

/** Refs whose values are too short to redact reliably. Surfaced rather than passed over. */
export function unredactable(secrets: SecretOccurrence[]): string[] {
  return secrets.filter((s) => s.value.length > 0 && s.value.length < MIN_REDACTABLE).map((s) => s.ref)
}

/**
 * Headers with every secret-bearing value replaced.
 *
 * Whole-value replacement by header name as well as by content, because an `authorization`
 * header is a leak whether or not its value came from the vault — an OAuth access token is
 * minted at call time and was never stored, so content matching alone would let it through.
 */
const ALWAYS_MASKED = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-figma-token'
])

export function redactHeaders(
  headers: Record<string, string>,
  secrets: SecretOccurrence[]
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (ALWAYS_MASKED.has(name.toLowerCase())) {
      out[name] = '[redacted]'
      continue
    }
    out[name] = redactWith(value, secrets)
  }
  return out
}

/**
 * A live view of the vault, used to redact.
 *
 * A callback rather than a snapshot: a secret set or rotated mid-session has to be redactable
 * immediately, and a redactor holding a list from startup would pass the new value straight
 * through — at exactly the moment the user is most likely to be testing it.
 */
export class Redactor {
  constructor(private readonly read: () => SecretOccurrence[]) {}

  text(value: string): string {
    return redactWith(value, this.read())
  }

  headers(headers: Record<string, string>): Record<string, string> {
    return redactHeaders(headers, this.read())
  }

  /** For a URL, which may carry a key in its query string. */
  url(value: string): string {
    return redactWith(value, this.read())
  }

  /** Refs too short to redact, so the UI can warn instead of implying protection. */
  weak(): string[] {
    return unredactable(this.read())
  }
}
