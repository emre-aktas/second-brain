import type {
  IntegrationManifest,
  IntegrationOperationSummary,
  IntegrationRecord,
  IntegrationStatus,
  IntegrationSummary,
  SecretState
} from '@shared/types'
import type { SecretDescriptor } from './secrets'

/**
 * What can be read off a manifest without touching the network or the vault.
 *
 * Pure and separate for one reason: the panel and `list_integrations` were two independent reads
 * of the same records, and they disagreed. The panel took every record; the agent's list took
 * only the ones whose tools it could enumerate, which excluded every disabled one — so an
 * integration the agent had just registered was simultaneously stored, testable, and reported as
 * not existing. One derivation, used by both, is the fix that keeps them honest.
 */

/**
 * Which vault refs an integration's credentials come from.
 *
 * Every kind carries them somewhere different, which is exactly why this is a table rather than
 * a field read: a new kind that forgets to declare its refs would silently drop out of the audit
 * trail, and the audit trail is the only record of what a token was used for.
 */
export function secretRefsOf(manifest: IntegrationManifest): string[] {
  const refs = new Set<string>()

  switch (manifest.kind) {
    case 'rest': {
      const auth = manifest.auth
      // 'none' has no ref; oauth2 stores its token under a ref of its own.
      if (auth.type === 'apiKey' || auth.type === 'bearer' || auth.type === 'basic') {
        refs.add(auth.secretRef)
      } else if (auth.type === 'oauth2') {
        // The client secret is optional — a public client has none — but the token the flow
        // mints is always stored, and it is the credential a call actually carries.
        if (auth.clientSecretRef) refs.add(auth.clientSecretRef)
        refs.add(`${manifest.id}.oauth`)
      }
      break
    }
    case 'mcp-stdio':
      for (const ref of Object.values(manifest.secretEnv ?? {})) refs.add(ref)
      break
    case 'mcp-http':
      for (const ref of Object.values(manifest.secretHeaders ?? {})) refs.add(ref)
      break
    case 'script':
      for (const ref of Object.values(manifest.secretEnv ?? {})) refs.add(ref)
      break
    case 'webhook':
      if (manifest.secretRef) refs.add(manifest.secretRef)
      break
  }

  return [...refs].filter(Boolean)
}

/**
 * The operations, in the form the user has to see before approving.
 *
 * Method and path for `rest`, because "it can reach three GET endpoints under api.figma.com" is
 * a decision someone can actually make. A name and a description alone is a request to trust
 * the agent's summary of what it wrote.
 */
export function operationsOf(manifest: IntegrationManifest): IntegrationOperationSummary[] {
  switch (manifest.kind) {
    case 'rest':
      return manifest.operations.map((op) => ({
        name: op.name,
        description: op.description,
        method: op.method,
        path: op.path,
        mutating: op.mutating === true
      }))
    case 'script':
      return manifest.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        mutating: tool.mutating === true
      }))
    case 'webhook':
      return [
        {
          name: 'inbound',
          description: `Receives POSTs at /hooks/${manifest.path} and files them as notes.`,
          method: 'POST',
          path: `/hooks/${manifest.path}`,
          mutating: false
        }
      ]
    // An MCP server declares its own tools at connect time, so there is nothing to list from
    // the manifest. The panel says as much rather than showing an empty list as if it meant
    // "can do nothing".
    case 'mcp-stdio':
    case 'mcp-http':
      return []
  }
}

/**
 * Which secret refs an integration declared but the user has not filled in.
 *
 * Declared, not used: `requiredSecrets` is the manifest's own statement of what it needs, and
 * it is what the approval surface is built from.
 */
export function missingSecretsOf(
  manifest: IntegrationManifest,
  descriptors: SecretDescriptor[]
): string[] {
  const set = new Set(descriptors.map((d) => d.ref))
  return (manifest.requiredSecrets ?? []).map((s) => s.ref).filter((ref) => !set.has(ref))
}

/**
 * Where an integration stands, in one word.
 *
 * Derived from `enabled` plus readiness rather than stored, so there is no fourth state that
 * can disagree with those two. `pending` is the one that had no name and therefore no surface:
 * registered, disabled, and still waiting for the credential the user has to supply.
 */
export function statusOf(manifest: IntegrationManifest, missing: string[]): IntegrationStatus {
  if (manifest.enabled) return 'enabled'
  return missing.length > 0 ? 'pending' : 'disabled'
}

function secretStates(
  manifest: IntegrationManifest,
  descriptors: SecretDescriptor[],
  now: number
): SecretState[] {
  const byRef = new Map(descriptors.map((d) => [d.ref, d]))

  return (manifest.requiredSecrets ?? []).map((declared) => {
    const stored = byRef.get(declared.ref)
    const expiresAt = stored?.expiresAt ?? null
    return {
      ref: declared.ref,
      label: declared.label,
      ...(declared.hint ? { hint: declared.hint } : {}),
      isSet: stored !== undefined,
      encrypted: stored?.encrypted ?? false,
      updatedAt: stored?.updatedAt ?? null,
      expiresAt,
      // Computed once, here, so the panel's warning and the agent's report cannot disagree
      // about whether a token is past its date.
      expired: expiresAt !== null && expiresAt <= now,
      // `setFor` is null for anything stored before the vault recorded it, which reads as "not
      // borrowed" — the honest answer, since nothing is known either way.
      borrowedFrom:
        stored?.setFor && stored.setFor !== manifest.id ? stored.setFor : null
    }
  })
}

/** The one description of an integration, for the panel and for the agent alike. */
export function summaryFor(
  record: IntegrationRecord,
  descriptors: SecretDescriptor[],
  now = Date.now()
): IntegrationSummary {
  const manifest = record.manifest
  const missing = missingSecretsOf(manifest, descriptors)

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    kind: manifest.kind,
    status: statusOf(manifest, missing),
    createdBy: manifest.createdBy,
    health: record.health,
    lastError: record.lastError,
    baseUrl: manifest.kind === 'rest' ? manifest.baseUrl : null,
    operations: operationsOf(manifest),
    secrets: secretStates(manifest, descriptors, now),
    missingSecrets: missing,
    ready: missing.length === 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}
