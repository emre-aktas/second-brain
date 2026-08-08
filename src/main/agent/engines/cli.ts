import { spawn } from 'node:child_process'
import type { CliStatus } from '@shared/engines'
import { providerById } from '@shared/engines'
import { claudeAuthStatus, forgetClaudeBinary, resolveClaudeBinary } from '../claude'
import { forgetCodexBinary, resolveCodexBinary } from './factory'
import { createLogger } from '../../logger'

const log = createLogger('engine:cli')

/**
 * Where someone actually is in getting a CLI engine working.
 *
 * Three questions, asked separately because they have three different answers and three
 * different fixes: is the program on this machine, is it signed in, and does it run. The panel
 * used to ask only the first, and answer a no with a toast — "Codex is not installed on this
 * machine" — which names a problem and offers no way through it. For someone who has never
 * opened a terminal that is where the app ends.
 *
 * Deliberately cheap. Every call here either reads a path or runs a local command that touches
 * no network, so the setup screen can re-ask after every step without costing anything.
 */

/** A local command, with a ceiling, because a setup screen must not hang on one. */
function run(binary: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(binary, args, { windowsHide: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    // Some of these write to stderr and still mean something; both are read.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      out += chunk
    })
    // Nothing here expects input, and an open stdin is how `codex exec` was made to hang.
    child.stdin.end()

    child.on('error', () => resolve(''))
    child.on('close', () => resolve(out))

    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill()
        resolve(out)
      }
    }, timeoutMs)
  })
}

/**
 * Read the state of one CLI, optionally forgetting what was cached first.
 *
 * The cache is the whole reason `recheck` exists: both binaries are resolved once and
 * remembered, so a user who installs the CLI while the app is open would be told it is still
 * missing until they restarted — which is exactly the moment the setup screen is asking them to
 * press "I've installed it".
 */
export async function cliStatus(providerId: string, recheck = false): Promise<CliStatus> {
  const provider = providerById(providerId)
  const absent: CliStatus = {
    providerId,
    installed: false,
    path: null,
    version: null,
    signedIn: null,
    account: null
  }
  if (!provider) return absent

  if (provider.engine === 'claude-cli') {
    if (recheck) forgetClaudeBinary()
    const binary = resolveClaudeBinary()
    if (!binary) return absent

    const [version, auth] = await Promise.all([
      run(binary, ['--version']).then((text) => text.trim().split('\n')[0] || null),
      claudeAuthStatus(binary)
    ])

    return {
      providerId,
      installed: true,
      path: binary,
      version,
      signedIn: auth ? auth.loggedIn : false,
      account:
        auth?.subscriptionType || auth?.email || (auth?.loggedIn ? 'signed in' : null) || null
    }
  }

  if (provider.engine === 'codex-cli') {
    if (recheck) forgetCodexBinary()
    const binary = resolveCodexBinary()
    if (!binary) return absent

    const [version, login] = await Promise.all([
      run(binary, ['--version']).then((text) => text.trim().split('\n')[0] || null),
      run(binary, ['login', 'status'])
    ])

    /*
     * A negative is believed; a positive is not.
     *
     * "Not logged in" is definite and worth showing, because it saves someone running a turn to
     * discover it. "Logged in using ChatGPT" is what this prints with a spent refresh token, so
     * it is reported as unknown rather than as yes — the check at the end of setup is the only
     * thing that can tell those apart, and it is one small turn.
     */
    const loggedOut = /not logged in|logged out|please (run|sign)/i.test(login)
    return {
      providerId,
      installed: true,
      path: binary,
      version,
      signedIn: loggedOut ? false : null,
      account: loggedOut ? null : login.trim().split('\n')[0]?.slice(0, 120) || null
    }
  }

  // An API provider is not a program on this machine; there is nothing here to install.
  log.info(`${providerId} is not a CLI; nothing to report`)
  return absent
}
