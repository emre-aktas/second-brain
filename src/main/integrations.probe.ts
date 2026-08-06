/**
 * Integrations: what exists, what can be called, and what must never leak.
 *
 * Three things are asserted here, and each of them was a real defect rather than a hypothetical.
 *
 * **A registered integration exists even when it cannot be called.** `list_integrations` reported
 * only what it could invoke, so an integration the agent had just registered — saved disabled by
 * design, waiting on a credential only the user can supply — came back as "No integrations are
 * connected yet" while sitting in storage and passing its own tests.
 *
 * **A failing authenticated request must not leak the credential.** This is the likeliest leak in
 * the app because it only happens on the unhappy path: a 401 body is handed to the agent to
 * explain the failure, and plenty of services echo the offending token back inside it. The test
 * for it runs a real request against a local server that does exactly that, proves the raw result
 * carries the token, and then proves the redactor removes it. Asserting only the second half
 * would pass just as well against a server that never echoed anything.
 *
 * **Derived forms count.** `basic` auth sends base64 of the stored value, so a redactor that only
 * knows the value it was given sails straight past the header on the wire.
 *
 * No model, no external network — the only server involved is started by this file.
 *
 *   node scripts/run-ts.mjs src/main/integrations.probe.ts --node
 */
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IntegrationRecord, IntegrationSummary, RestManifest } from '@shared/types'
import { buildBrainTools } from './agent/tools'
import { BrainCore } from './core'
import { SettingsStore } from './settings'
import { IntegrationRegistry } from './integrations/registry'
import { RestAdapter } from './integrations/adapters'
import { missingSecretsOf, operationsOf, secretRefsOf, statusOf, summaryFor } from './integrations/manifest'
import { OAuthManager } from './integrations/oauth'
import { redactHeaders, redactWith, secretForms, unredactable, Redactor } from './integrations/redact'
import { SecretVault } from './integrations/secrets'
import type { SecretDescriptor } from './integrations/secrets'

let failures = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ok    ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}`)
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`)
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) console.log(`  ok    ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}`)
    console.log(`        expected ${JSON.stringify(expected)}`)
    console.log(`        actual   ${JSON.stringify(actual)}`)
  }
}

/* ------------------------------------------------------------------ fixtures */

/** The manifest from the report: agent-registered, disabled, one secret, three GETs. */
function figmaManifest(overrides: Partial<RestManifest> = {}): RestManifest {
  return {
    kind: 'rest',
    id: 'figma-rest',
    name: 'Figma (read-only)',
    description: 'Reads Figma files, nodes and comments.',
    enabled: false,
    createdBy: 'agent',
    baseUrl: 'https://api.figma.com',
    auth: { type: 'apiKey', in: 'header', name: 'X-Figma-Token', secretRef: 'figma_pat' },
    requiredSecrets: [
      { ref: 'figma_pat', label: 'Figma personal access token', hint: 'figma.com → Settings' }
    ],
    operations: [
      {
        name: 'get_file',
        description: 'One file.',
        method: 'GET',
        path: '/v1/files/{file_key}',
        pathParams: [{ name: 'file_key', type: 'string', required: true }]
      },
      {
        name: 'get_nodes',
        description: 'Nodes in a file.',
        method: 'GET',
        path: '/v1/files/{file_key}/nodes',
        pathParams: [{ name: 'file_key', type: 'string', required: true }]
      },
      {
        name: 'get_comments',
        description: 'Comments on a file.',
        method: 'GET',
        path: '/v1/files/{file_key}/comments',
        pathParams: [{ name: 'file_key', type: 'string', required: true }]
      }
    ],
    ...overrides
  } as RestManifest
}

function recordFor(manifest: RestManifest): IntegrationRecord {
  return {
    manifest,
    health: 'ok',
    lastError: null,
    lastCheckedAt: Date.now(),
    toolCount: manifest.operations.length,
    createdAt: 1,
    updatedAt: 2
  }
}

const SET: SecretDescriptor = {
  ref: 'figma_pat',
  encrypted: true,
  updatedAt: 1000,
  expiresAt: null,
  expired: false,
  setFor: 'figma-rest'
}

/* --------------------------------------------------------- what the panel sees */

console.log('what is known about an integration\n')

{
  const pending = summaryFor(recordFor(figmaManifest()), [])
  eq('a registered integration with no credential is pending', pending.status, 'pending')
  eq('and says which ref is missing', pending.missingSecrets, ['figma_pat'])
  eq('it is not ready to be enabled', pending.ready, false)
  eq('the agent is named as its author', pending.createdBy, 'agent')
  eq('the base URL is carried, so the user can see what it reaches', pending.baseUrl, 'https://api.figma.com')

  // Method and path, not just a name: "three GET endpoints under api.figma.com" is a decision
  // someone can make; "an integration the agent wrote" is a request to trust a summary.
  eq('every operation is listed with its method and path', pending.operations, [
    { name: 'get_file', description: 'One file.', method: 'GET', path: '/v1/files/{file_key}', mutating: false },
    { name: 'get_nodes', description: 'Nodes in a file.', method: 'GET', path: '/v1/files/{file_key}/nodes', mutating: false },
    { name: 'get_comments', description: 'Comments on a file.', method: 'GET', path: '/v1/files/{file_key}/comments', mutating: false }
  ])

  const declared = pending.secrets[0]
  eq('the secret is described by its label', declared.label, 'Figma personal access token')
  eq('with its hint', declared.hint, 'figma.com → Settings')
  eq('and reported unset', declared.isSet, false)
  // The rule the whole design rests on: this shape has no field a value could travel in.
  check('the secret state carries no value', !('value' in declared), Object.keys(declared))
}

{
  const ready = summaryFor(recordFor(figmaManifest()), [SET])
  eq('with the credential in place it is merely disabled', ready.status, 'disabled')
  eq('and ready to enable', ready.ready, true)
  eq('nothing is missing', ready.missingSecrets, [])

  const enabled = summaryFor(recordFor(figmaManifest({ enabled: true })), [SET])
  eq('enabled reads as enabled', enabled.status, 'enabled')
}

{
  // An enabled integration whose credential was never stored is a real state — the switch could
  // have been flipped before this gate existed — and it must not read as ready.
  const inconsistent = summaryFor(recordFor(figmaManifest({ enabled: true })), [])
  eq('an enabled integration missing its secret still reports it', inconsistent.missingSecrets, ['figma_pat'])
  eq('and is not ready', inconsistent.ready, false)
}

{
  const past: SecretDescriptor = { ...SET, expiresAt: Date.now() - 60_000, expired: true }
  const expired = summaryFor(recordFor(figmaManifest()), [past])
  eq('an expired credential is flagged', expired.secrets[0].expired, true)
  // Still "set": the value is there, it has simply stopped being useful. Reporting it as unset
  // would send the user to paste it again with no explanation of why.
  eq('and still counts as set', expired.secrets[0].isSet, true)
}

eq('a rest integration declares the ref its auth uses', secretRefsOf(figmaManifest()), ['figma_pat'])
// The argument is the *missing* list, which is what makes the status derived: the same manifest
// reads pending or disabled depending only on whether the credential is there.
eq('statusOf reads pending when a ref is missing', statusOf(figmaManifest(), ['figma_pat']), 'pending')
eq('and disabled when nothing is missing', statusOf(figmaManifest(), []), 'disabled')
eq('enabled outranks both', statusOf(figmaManifest({ enabled: true }), ['figma_pat']), 'enabled')
eq('and missing refs come from the manifest', missingSecretsOf(figmaManifest(), []), ['figma_pat'])
eq('operations survive the round trip', operationsOf(figmaManifest()).length, 3)

/* ------------------------------------------- the tool that said it did not exist */

async function listIntegrationsChecks(): Promise<void> {
  console.log('\nlist_integrations')

  async function listIntegrationsSays(summaries: IntegrationSummary[], callable: boolean): Promise<string> {
    const tools = buildBrainTools({
      integrations: {
        // Correctly empty for a disabled integration: being unable to call something is not the
        // same as it not existing, and conflating the two is the bug.
        listTools: async () =>
          callable
            ? [
                {
                  integrationId: 'figma-rest',
                  integrationName: 'Figma (read-only)',
                  qualifiedName: 'figma-rest.get_file',
                  description: 'One file.',
                  mutating: false
                }
              ]
            : [],
        describeAll: () => summaries,
        callTool: async () => ({ content: '', isError: false }),
        register: async () => ({ ok: true, message: '', needsApproval: true }),
        test: async () => ({ ok: true, message: '' })
      }
    } as never)

    const tool = tools.find((entry) => entry.name === 'list_integrations')
    if (!tool) throw new Error('list_integrations is gone from the tool table')
    const result = await tool.handler({}, null as never)
    return typeof result === 'string' ? result : JSON.stringify(result)
  }

  {
    const pending = summaryFor(recordFor(figmaManifest()), [])
    const said = await listIntegrationsSays([pending], false)

    // The deliverable: a disabled integration appears.
    check('a disabled integration is reported', said.includes('Figma (read-only)'), said)
    check('by id, so the agent can refer to it', said.includes('figma-rest'), said)
    check('with its status', said.includes('pending'), said)
    check('and who registered it', said.includes('added by agent'), said)
    check('the missing ref is named', said.includes('figma_pat'), said)
    check('the operation count is given', said.includes('3 operation(s)'), said)
    check('and it is not claimed to be connected', !said.includes('No integrations are'), said)
    // The old wording, which is what the agent acted on.
    check(
      'the phrase that caused the bug is gone',
      !said.includes('No integrations are connected yet'),
      said
    )
    check('the agent is told not to call it', /not callable/i.test(said), said)
    check('and not to register it again', /register them again/i.test(said), said)
  }

  {
    // With nothing at all, the old message is still the right one.
    const said = await listIntegrationsSays([], false)
    check('an empty install says so', /No integrations are registered yet/.test(said), said)
  }

  {
    const enabled = summaryFor(recordFor(figmaManifest({ enabled: true })), [SET])
    const said = await listIntegrationsSays([enabled], true)
    check('an enabled one is listed as callable', /Connected and callable/.test(said), said)
    check('with its qualified operation name', said.includes('figma-rest.get_file'), said)
    check('and no waiting section', !/not callable/i.test(said), said)
  }
}

/* --------------------------------------------------------------- redaction */

console.log('\nredaction')

const TOKEN = 'figd_ZmFrZS10b2tlbi1mb3ItdGhlLXByb2JlLW9ubHk'
const SECRETS = [{ ref: 'figma_pat', value: TOKEN }]

eq(
  'a value in an error body is replaced by its ref',
  redactWith(`{"err":"Invalid token: ${TOKEN}"}`, SECRETS),
  '{"err":"Invalid token: [redacted: figma_pat]"}'
)
check('every occurrence goes, not just the first', !redactWith(`${TOKEN} and ${TOKEN}`, SECRETS).includes(TOKEN))
// `basic` auth sends base64(value); a redactor that only knows the value misses the header.
check(
  'the base64 form is covered',
  !redactWith(
    `Authorization: Basic ${Buffer.from(TOKEN, 'utf8').toString('base64')}`,
    SECRETS
  ).includes(Buffer.from(TOKEN, 'utf8').toString('base64'))
)
// `apiKey` with `in: 'query'` puts it in the URL, which reaches error messages from several
// directions — a fetch failure, a redirect, an exception's cause.
{
  const withKey = `request to https://api.example.com/v1?token=${encodeURIComponent(TOKEN)} failed`
  check('a value in a URL query goes too', !redactWith(withKey, SECRETS).includes(TOKEN), redactWith(withKey, SECRETS))
}
eq('text with no secret in it is untouched', redactWith('all clear', SECRETS), 'all clear')
eq('an empty string survives', redactWith('', SECRETS), '')

// An `authorization` header is a leak whether or not its value came from the vault: an OAuth
// access token is minted at call time and was never stored, so content matching alone misses it.
{
  const masked = redactHeaders(
    { authorization: 'Bearer minted-at-call-time-never-stored', accept: 'application/json' },
    SECRETS
  )
  eq('authorization is masked by name', masked['authorization'], '[redacted]')
  eq('and an innocent header is left alone', masked['accept'], 'application/json')
  eq(
    'a vendor token header is masked too',
    redactHeaders({ 'X-Figma-Token': TOKEN }, SECRETS)['X-Figma-Token'],
    '[redacted]'
  )
}

// Substring replacement cannot work on a short value: it occurs inside ordinary text and
// redacting it would corrupt unrelated output while protecting nothing. Reported, not ignored.
eq('a short value is declared unredactable', unredactable([{ ref: 'pin', value: '1234' }]), ['pin'])
eq('a real credential is redactable', unredactable(SECRETS), [])
check('and short values are not used as patterns', redactWith('a 1234 b', [{ ref: 'pin', value: '1234' }]) === 'a 1234 b')
check('forms of a short value are dropped', secretForms('1234').length === 0)

/* --------------------------- the leak that only happens when the request fails */

async function withServer(
  handler: (body: string) => { status: number; body: string },
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server: Server = createServer((req, res) => {
    // The exact hostile-but-common behaviour: quote the offending credential back.
    const sent = String(req.headers['x-figma-token'] ?? '')
    const answer = handler(sent)
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    res.end(answer.body)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function main(): Promise<void> {
  await listIntegrationsChecks()

  console.log('\na failing authenticated request')

  const dir = mkdtempSync(join(tmpdir(), 'brain-secrets-'))
  try {
    // A real vault. Under plain Node `safeStorage` is unavailable, which is exactly the fallback
    // path — so this also exercises the AES-256-GCM cipher and its round trip.
    const vault = new SecretVault(join(dir, 'secrets.json'))
    vault.set('figma_pat', TOKEN)

    eq('the fallback cipher round-trips', vault.get('figma_pat'), TOKEN)
    check('and does not store the value in the clear', !vault.secure)
    eq('metadata is readable without the value', vault.describe('figma_pat')?.encrypted, false)

    const expiry = Date.now() + 7 * 24 * 3600_000
    vault.set('short_lived', 'another-long-enough-token-value', expiry)
    eq('an expiry is stored', vault.describe('short_lived')?.expiresAt, expiry)
    eq('and is not expired yet', vault.describe('short_lived')?.expired, false)
    vault.setExpiry('short_lived', Date.now() - 1000)
    eq('a past expiry reads as expired', vault.describe('short_lived')?.expired, true)
    eq('and the value is untouched by that', vault.get('short_lived'), 'another-long-enough-token-value')

    const redactor = new Redactor(() => vault.values())

    await withServer(
      (sent) => ({
        status: 401,
        // What a real service does often enough to matter.
        body: JSON.stringify({ status: 401, err: `Invalid token "${sent}"` })
      }),
      async (baseUrl) => {
        const manifest = figmaManifest({ baseUrl })
        const adapter = new RestAdapter(manifest, vault, new OAuthManager(vault))
        const raw = await adapter.call('get_file', { file_key: 'abc' })

        eq('the request failed, as arranged', raw.isError, true)
        eq('and the status came back as a number', raw.httpStatus, 401)

        // Half one: the leak is real. Without this the next assertion would pass against a
        // server that never echoed anything, which is a test of nothing.
        check('the raw adapter result does contain the token', raw.content.includes(TOKEN))

        // Half two: the boundary the registry applies removes it.
        const guarded = redactor.text(raw.content)
        check('the redacted result does not', !guarded.includes(TOKEN), guarded)
        check('it still explains the failure', /401/.test(guarded), guarded)
        check('and names the credential involved', guarded.includes('figma_pat'), guarded)
      }
    )

    /* ----------------------------------------------------- the live connection test */

    console.log('\nthe connection test')

    await withServer(
      (sent) => (sent === TOKEN ? { status: 200, body: '{"ok":true}' } : { status: 403, body: '{"err":"nope"}' }),
      async (baseUrl) => {
        // No required params on this one, so the probe has something to call.
        const manifest = figmaManifest({
          baseUrl,
          operations: [
            { name: 'me', description: 'Who am I.', method: 'GET', path: '/v1/me' }
          ]
        } as Partial<RestManifest>)

        const good = await new RestAdapter(manifest, vault, new OAuthManager(vault)).probe()
        eq('a working credential passes', good.ok, true)
        eq('with the status it got', good.status, 200)
        eq('and names what it called', good.target, 'GET /v1/me')

        vault.set('figma_pat', 'a-different-token-that-is-wrong')
        const bad = await new RestAdapter(manifest, vault, new OAuthManager(vault)).probe()
        eq('a rejected credential fails', bad.ok, false)
        eq('with the status that says so', bad.status, 403)
      }
    )

    /* ------------------------------------------------------------- deletion */

    vault.delete('figma_pat')
    eq('a deleted secret is gone', vault.get('figma_pat'), undefined)
    eq('and stops being described', vault.describe('figma_pat'), undefined)
    check('so it drops out of the redactor', !vault.values().some((v) => v.ref === 'figma_pat'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  /* ---------------------------------------------------------- the whole loop */

  console.log('\nthe loop, through the real registry')

  {
    const root = mkdtempSync(join(tmpdir(), 'brain-integrations-'))
    mkdirSync(join(root, '.brain'), { recursive: true })

    const paths = {
      root,
      vaultDir: join(root, 'vault'),
      integrationsDir: join(root, 'integrations'),
      attachmentsDir: join(root, 'attachments'),
      trashDir: join(root, '.trash'),
      dbPath: join(root, '.brain', 'index.db'),
      settingsFile: join(root, 'settings.json'),
      secretsFile: join(root, 'secrets.enc'),
      logFile: join(root, '.brain', 'app.log'),
      designFile: join(root, '.brain', 'DESIGN.md')
    }
    mkdirSync(paths.vaultDir, { recursive: true })

    const settings = new SettingsStore(paths.settingsFile, root)
    const core = new BrainCore(paths, settings)
    core.setBroadcast(() => {})
    const registry = new IntegrationRegistry(core)

    try {
      await withServer(
        (sent) =>
          sent === TOKEN
            ? { status: 200, body: JSON.stringify({ name: 'a file' }) }
            : { status: 403, body: JSON.stringify({ err: `Invalid token "${sent}"` }) },
        async (baseUrl) => {
          // 1. The agent registers it. Disabled, by design.
          const registered = await registry.register(figmaManifest({ baseUrl }))
          check('the agent can register it', registered.ok, registered)
          check('and is told it needs approval', registered.needsApproval, registered)

          // 2. It exists, and says what it is waiting for.
          const pending = registry.describe('figma-rest')
          eq('it is stored as pending', pending?.status, 'pending')
          eq('naming the ref it needs', pending?.missingSecrets, ['figma_pat'])

          // 3. Enabling is refused until the credential is there. Refused in the registry, not
          //    only in the panel: a rule enforced at the surface holds until the next caller.
          let refused = ''
          try {
            registry.setEnabled('figma-rest', true)
          } catch (err) {
            refused = err instanceof Error ? err.message : String(err)
          }
          check('enabling without the credential is refused', refused.length > 0, refused)
          check('and the refusal names the ref', refused.includes('figma_pat'), refused)
          eq('so it is still not enabled', registry.describe('figma-rest')?.status, 'pending')

          // 4. The user supplies it — the path the panel takes, with an expiry.
          const expires = Date.now() + 7 * 24 * 3600_000
          registry.setSecret('figma_pat', TOKEN, expires)
          const ready = registry.describe('figma-rest')
          eq('with the credential in, it is ready', ready?.ready, true)
          eq('the expiry is remembered', ready?.secrets[0].expiresAt, expires)
          eq('and it is not expired', ready?.secrets[0].expired, false)

          // 5. Test connection: one live authenticated request.
          const probe = await registry.probe('figma-rest')
          check('the connection test passes', probe.ok, probe)
          eq('with the status it got', probe.httpStatus, 200)
          check('and says the credential works', /credential works/i.test(probe.message), probe.message)

          // 6. Now it can be enabled, and only now.
          registry.setEnabled('figma-rest', true)
          eq('it enables', registry.describe('figma-rest')?.status, 'enabled')

          // 7. The agent calls an operation, successfully.
          const called = await registry.callTool('figma-rest', 'get_file', { file_key: 'abc' })
          check('the call succeeds', called.isError !== true, called)
          check('and returns the payload', called.content.includes('a file'), called.content)

          // 8. The audit trail has it — with the ref, and no value anywhere in the row.
          const trail = registry.auditTrail('figma-rest', 10)
          check('the call was audited', trail.length >= 2, trail.length)
          const call = trail.find((entry) => entry.operation === 'get_file')
          eq('the operation is named', call?.operation, 'get_file')
          eq('the credential is named by ref', call?.secretRefs, ['figma_pat'])
          eq('the outcome is recorded', call?.ok, true)
          eq('with the HTTP status', call?.httpStatus, 200)
          check('the test is in there too', trail.some((e) => e.operation === '(connection test)'), trail.map((e) => e.operation))
          check(
            'and no row carries a value',
            !JSON.stringify(trail).includes(TOKEN),
            'a secret value reached the audit trail'
          )

          // 9. A failing call, and the credential must not come back with the error.
          registry.setSecret('figma_pat', 'a-wrong-but-long-enough-token')
          const failed = await registry.callTool('figma-rest', 'get_file', { file_key: 'abc' })
          check('a rejected call reports an error', failed.isError === true, failed)
          check(
            'and the error does not carry the credential',
            !failed.content.includes('a-wrong-but-long-enough-token'),
            failed.content
          )
          check('it names the ref instead', failed.content.includes('figma_pat'), failed.content)

          // 10. Deleting the credential takes the integration out of service with it, rather
          //     than leaving it enabled to fail inside somebody's turn.
          registry.deleteSecret('figma_pat')
          const after = registry.describe('figma-rest')
          eq('deleting the secret disables it', after?.status, 'pending')
          eq('and it is unset again', after?.secrets[0].isSet, false)
        }
      )
    } finally {
      registry.stop()
      core.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  }

  console.log(failures === 0 ? '\nall integration checks passed\n' : `\n${failures} check(s) failed\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

void main().catch((err) => {
  console.log(`FATAL ${(err as Error).stack ?? String(err)}`)
  process.exitCode = 1
})
