import { spawn, type ChildProcess } from 'node:child_process'
import { createLogger } from '../logger'

const log = createLogger('kill')

/**
 * Whether a spawned child should lead its own process group.
 *
 * On POSIX this is what makes a *tree* killable: signal the negative pid and every
 * descendant gets it. Without it, killing a child that has itself spawned children — which
 * every one of ours has, because `claude` runs MCP servers and `npx` runs node — leaves the
 * grandchildren running with no parent and no way to find them again.
 *
 * Off on Windows, which has no process groups to lead; there the tree is taken apart by
 * `taskkill /T` below.
 */
export const DETACH_CHILDREN = process.platform !== 'win32'

/**
 * End a child process and everything it started.
 *
 * `child.kill()` signals one process. That was enough when the app quit and the OS reaped
 * the rest, and it stopped being enough the moment the window could close without the app
 * quitting: the CLI, the MCP servers it runs and the node processes under those all
 * survived, so a session of opening and closing the app left a row of orphans behind.
 *
 * Deliberately fire-and-forget. This runs during teardown, and the main process has one
 * thread — `spawnSync('taskkill')` here would block every window and the quit itself.
 */
export function killTree(child: ChildProcess | null | undefined): void {
  const pid = child?.pid
  if (!child || pid === undefined) return

  if (process.platform === 'win32') {
    try {
      // /T takes the children with it, /F does not ask. Detached and unref'd so it can
      // outlive the process that asked for it — which, during a quit, it has to.
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      })
      killer.unref()
      killer.on('error', (err) => log.debug(`taskkill for ${pid} failed: ${String(err)}`))
    } catch (err) {
      log.debug(`taskkill for ${pid} could not start: ${String(err)}`)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    return
  }

  // The whole group, if this child leads one. A child spawned before `DETACH_CHILDREN` was
  // honoured — or one whose group has already gone — falls back to signalling it directly,
  // which is no worse than what came before.
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }

  // A grace period, then insist. Unref'd because a quit must not wait on it: if the process
  // is already going away, the timer never needs to fire.
  const insist = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }, 2000)
  insist.unref?.()
}
