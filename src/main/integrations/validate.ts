import { z } from 'zod'
import type { IntegrationManifest } from '@shared/types'

/**
 * Manifest validation.
 *
 * The agent authors these, so validation has to be strict and the errors have to
 * be readable enough for it to correct itself in one pass. It also enforces the
 * rules that matter for safety: an id that is safe to use as a folder name and an
 * MCP server key, and no secrets inlined into the manifest.
 */

const Id = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z][a-z0-9-]*$/, 'must be lower-case letters, digits and hyphens, starting with a letter')

const Common = {
  id: Id,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  icon: z.string().max(48).optional(),
  enabled: z.boolean().default(false),
  createdBy: z.enum(['user', 'agent', 'preset']).default('agent'),
  version: z.string().max(24).optional(),
  requiredSecrets: z
    .array(
      z.object({
        ref: z.string().min(1).max(120),
        label: z.string().min(1).max(120),
        hint: z.string().max(300).optional()
      })
    )
    .max(8)
    .optional()
}

const ParamSpec = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(300).optional(),
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional()
})

const AuthSpec = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('apiKey'),
    in: z.enum(['header', 'query']),
    name: z.string().min(1).max(80),
    secretRef: z.string().min(1).max(120)
  }),
  z.object({ type: z.literal('bearer'), secretRef: z.string().min(1).max(120) }),
  z.object({ type: z.literal('basic'), secretRef: z.string().min(1).max(120) }),
  z.object({
    type: z.literal('oauth2'),
    authUrl: z.string().url(),
    tokenUrl: z.string().url(),
    clientIdRef: z.string().min(1).max(120),
    clientSecretRef: z.string().min(1).max(120).optional(),
    scopes: z.array(z.string()).max(40),
    pkce: z.boolean(),
    authParams: z.record(z.string(), z.string()).optional(),
    tokenRef: z.string().min(1).max(120)
  })
])

const RestOperation = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, 'must be snake_case'),
  description: z.string().min(1).max(400),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(400),
  pathParams: z.array(ParamSpec).max(10).optional(),
  query: z.array(ParamSpec).max(20).optional(),
  bodyParams: z.array(ParamSpec).max(30).optional(),
  rawBody: z.boolean().optional(),
  resultPath: z.string().max(120).optional(),
  mutating: z.boolean().optional()
})

const ToolSpec = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, 'must be snake_case'),
  description: z.string().min(1).max(400),
  inputSchema: z.record(z.string(), z.unknown()),
  mutating: z.boolean().optional()
})

const ManifestSchema = z.discriminatedUnion('kind', [
  z.object({
    ...Common,
    kind: z.literal('mcp-stdio'),
    command: z.string().min(1).max(400),
    args: z.array(z.string()).max(40).default([]),
    env: z.record(z.string(), z.string()).optional(),
    secretEnv: z.record(z.string(), z.string()).optional(),
    cwd: z.string().max(400).optional()
  }),
  z.object({
    ...Common,
    kind: z.literal('mcp-http'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    secretHeaders: z.record(z.string(), z.string()).optional()
  }),
  z.object({
    ...Common,
    kind: z.literal('rest'),
    baseUrl: z.string().url(),
    auth: AuthSpec,
    defaultHeaders: z.record(z.string(), z.string()).optional(),
    operations: z.array(RestOperation).min(1).max(40)
  }),
  z.object({
    ...Common,
    kind: z.literal('script'),
    entry: z
      .string()
      .min(1)
      .max(120)
      .refine((v) => !v.includes('..'), 'must not contain ".."'),
    tools: z.array(ToolSpec).min(1).max(30),
    env: z.record(z.string(), z.string()).optional(),
    secretEnv: z.record(z.string(), z.string()).optional()
  }),
  z.object({
    ...Common,
    kind: z.literal('webhook'),
    path: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9-]+$/, 'must be lower-case letters, digits and hyphens'),
    secretRef: z.string().max(120).optional(),
    capture: z.object({
      titleField: z.string().max(80).optional(),
      bodyField: z.string().max(80).optional(),
      tags: z.array(z.string()).max(10).optional(),
      kind: z.enum(['note', 'source', 'event', 'task']).optional()
    })
  })
])

export interface ValidationResult {
  ok: boolean
  manifest?: IntegrationManifest
  errors: string[]
  warnings: string[]
}

// Values that look like credentials must not be baked into a manifest, since it
// is stored as plain JSON and shown to the user.
const SECRET_LOOKALIKE = /(sk-[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[a-zA-Z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/

export function validateManifest(input: unknown): ValidationResult {
  const parsed = ManifestSchema.safeParse(input)

  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues
        .slice(0, 20)
        .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`),
      warnings: []
    }
  }

  const manifest = parsed.data as IntegrationManifest
  const errors: string[] = []
  const warnings: string[] = []

  const serialised = JSON.stringify(manifest)
  const leak = serialised.match(SECRET_LOOKALIKE)
  if (leak) {
    errors.push(
      `the manifest appears to contain a live credential (${leak[0].slice(0, 8)}…). Declare it under requiredSecrets and reference it by ref instead.`
    )
  }

  if (manifest.kind === 'rest' && manifest.auth.type === 'oauth2') {
    const refs = new Set((manifest.requiredSecrets ?? []).map((s) => s.ref))
    if (!refs.has(manifest.auth.clientIdRef)) {
      warnings.push(
        `clientIdRef "${manifest.auth.clientIdRef}" is not listed in requiredSecrets, so the user will not be prompted for it`
      )
    }
  }

  if (manifest.kind === 'mcp-stdio') {
    // Anything spawned here runs with the app's privileges.
    warnings.push(
      `this integration runs "${manifest.command}" as a local process — review the command before enabling it`
    )
  }

  if (manifest.kind === 'rest') {
    const mutating = manifest.operations.filter((o) => o.mutating ?? o.method !== 'GET')
    if (mutating.length) {
      warnings.push(
        `${mutating.length} operation(s) can change data in the service: ${mutating.map((o) => o.name).join(', ')}`
      )
    }
  }

  return { ok: errors.length === 0, manifest, errors, warnings }
}
