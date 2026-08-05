import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { shell } from 'electron'
import type { AuthSpec } from '@shared/types'
import type { SecretVault } from './secrets'
import { createLogger } from '../logger'

const log = createLogger('oauth')

export interface TokenBundle {
  accessToken: string
  refreshToken?: string
  /** Epoch millis. */
  expiresAt?: number
  tokenType: string
  scope?: string
}

type OAuth2Spec = Extract<AuthSpec, { type: 'oauth2' }>

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * OAuth2 authorization-code flow with PKCE against a loopback redirect.
 *
 * A loopback redirect is used rather than a custom protocol handler because it is
 * what Google and most providers accept for desktop clients, and it needs no
 * registration with the OS. The consent screen opens in the user's real browser,
 * so existing sessions apply and this app never sees their password.
 */
export class OAuthManager {
  constructor(private secrets: SecretVault) {}

  /** Run the interactive consent flow and store the resulting tokens. */
  async authorize(integrationId: string, spec: OAuth2Spec): Promise<TokenBundle> {
    const clientId = this.secrets.get(spec.clientIdRef)
    if (!clientId) {
      throw new Error(
        `Missing client id. Add the secret "${spec.clientIdRef}" in the integration's settings first.`
      )
    }
    const clientSecret = spec.clientSecretRef ? this.secrets.get(spec.clientSecretRef) : undefined

    const verifier = base64url(randomBytes(48))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = base64url(randomBytes(16))

    const { server, port, waitForCode } = await this.startLoopback(state)
    const redirectUri = `http://127.0.0.1:${port}/callback`

    const authUrl = new URL(spec.authUrl)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('state', state)
    if (spec.scopes.length) authUrl.searchParams.set('scope', spec.scopes.join(' '))
    if (spec.pkce) {
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
    }
    for (const [key, value] of Object.entries(spec.authParams ?? {})) {
      authUrl.searchParams.set(key, value)
    }

    log.info(`opening consent screen for ${integrationId}`)
    await shell.openExternal(authUrl.toString())

    try {
      const code = await waitForCode
      const tokens = await this.exchange(spec, {
        code,
        redirectUri,
        clientId,
        clientSecret,
        verifier: spec.pkce ? verifier : undefined
      })
      this.secrets.setJson(spec.tokenRef, tokens)
      return tokens
    } finally {
      server.close()
    }
  }

  private startLoopback(
    expectedState: string
  ): Promise<{ server: Server; port: number; waitForCode: Promise<string> }> {
    return new Promise((resolve, reject) => {
      let settle: ((code: string) => void) | null = null
      let bail: ((err: Error) => void) | null = null

      const waitForCode = new Promise<string>((res, rej) => {
        settle = res
        bail = rej
      })

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (!url.pathname.startsWith('/callback')) {
          res.writeHead(404).end()
          return
        }

        const error = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')

        const reply = (title: string, body: string): void => {
          const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px/1.6 system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#111;color:#eee"><div style="text-align:center;max-width:32rem"><h1 style="font-size:1.25rem;font-weight:600">${title}</h1><p style="color:#aaa">${body}</p></div></body>`
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
        }

        if (error) {
          reply('Authorization declined', 'You can close this tab and try again in the app.')
          bail?.(new Error(`the provider returned "${error}"`))
          return
        }
        // A mismatched state means the response did not come from our request.
        if (state !== expectedState) {
          reply('Authorization failed', 'The response did not match this request. Close this tab and retry.')
          bail?.(new Error('state mismatch — the callback did not match our request'))
          return
        }
        if (!code) {
          reply('Authorization failed', 'No authorization code was returned.')
          bail?.(new Error('no authorization code in the callback'))
          return
        }

        reply('Connected', 'You can close this tab and go back to Second Brain.')
        settle?.(code)
      })

      server.on('error', reject)
      // Port 0 lets the OS choose; the provider must allow any loopback port,
      // which is the documented behaviour for desktop OAuth clients.
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0

        const timeout = setTimeout(() => {
          bail?.(new Error('the authorization window timed out after 5 minutes'))
          server.close()
        }, 5 * 60_000)
        timeout.unref?.()

        resolve({ server, port, waitForCode })
      })
    })
  }

  private async exchange(
    spec: OAuth2Spec,
    input: {
      code: string
      redirectUri: string
      clientId: string
      clientSecret?: string
      verifier?: string
    }
  ): Promise<TokenBundle> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId
    })
    if (input.clientSecret) body.set('client_secret', input.clientSecret)
    if (input.verifier) body.set('code_verifier', input.verifier)

    const res = await fetch(spec.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body
    })

    const text = await res.text()
    if (!res.ok) throw new Error(`token exchange failed (HTTP ${res.status}): ${text.slice(0, 300)}`)

    return parseTokenResponse(text)
  }

  /** Valid access token for a spec, refreshing transparently when needed. */
  async accessToken(spec: OAuth2Spec): Promise<string> {
    const stored = this.secrets.getJson<TokenBundle>(spec.tokenRef)
    if (!stored) throw new Error('not connected yet — authorize this integration first')

    const stillValid = !stored.expiresAt || stored.expiresAt - Date.now() > 60_000
    if (stillValid) return stored.accessToken

    if (!stored.refreshToken) {
      throw new Error('the access token expired and no refresh token is stored — reconnect required')
    }

    const clientId = this.secrets.get(spec.clientIdRef)
    if (!clientId) throw new Error('client id is missing from the secret store')
    const clientSecret = spec.clientSecretRef ? this.secrets.get(spec.clientSecretRef) : undefined

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      client_id: clientId
    })
    if (clientSecret) body.set('client_secret', clientSecret)

    const res = await fetch(spec.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`token refresh failed (HTTP ${res.status}) — reconnect required`)

    const refreshed = parseTokenResponse(text)
    // Providers commonly omit the refresh token on refresh; keep the old one.
    if (!refreshed.refreshToken) refreshed.refreshToken = stored.refreshToken

    this.secrets.setJson(spec.tokenRef, refreshed)
    return refreshed.accessToken
  }

  isConnected(spec: OAuth2Spec): boolean {
    return this.secrets.has(spec.tokenRef)
  }

  disconnect(spec: OAuth2Spec): void {
    this.secrets.delete(spec.tokenRef)
  }
}

function parseTokenResponse(text: string): TokenBundle {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(text) as Record<string, unknown>
  } catch {
    // A few providers still answer form-encoded.
    payload = Object.fromEntries(new URLSearchParams(text))
  }

  const accessToken = payload['access_token']
  if (typeof accessToken !== 'string') {
    throw new Error('the token response contained no access_token')
  }

  const expiresIn = payload['expires_in']
  return {
    accessToken,
    refreshToken: typeof payload['refresh_token'] === 'string' ? payload['refresh_token'] : undefined,
    expiresAt:
      typeof expiresIn === 'number'
        ? Date.now() + expiresIn * 1000
        : typeof expiresIn === 'string' && Number.isFinite(Number(expiresIn))
          ? Date.now() + Number(expiresIn) * 1000
          : undefined,
    tokenType: typeof payload['token_type'] === 'string' ? payload['token_type'] : 'Bearer',
    scope: typeof payload['scope'] === 'string' ? payload['scope'] : undefined
  }
}
