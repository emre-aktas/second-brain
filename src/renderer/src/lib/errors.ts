import { api } from '@/lib/api'

/**
 * Send whatever the renderer throws to the app's own log.
 *
 * Nothing did, before this. An exception inside a component left the surface it was drawing
 * blank and wrote to a devtools console nobody had open — so "the graph disappeared" arrived
 * with no evidence attached, and diagnosing it meant guessing at mechanisms and trying to
 * reproduce each one. The log is the one place a user can be asked to look.
 *
 * Deliberately not a UI: an error the app can recover from should not become a dialog, and
 * one it cannot will show as the missing surface anyway. This is for the record.
 */
export function captureRendererErrors(): void {
  const send = (kind: string, message: string, stack: string | null, where: string | null): void => {
    // Failure here is not worth reporting to itself.
    void api.reportRendererError({ kind, message, stack, where }).catch(() => undefined)
  }

  window.addEventListener('error', (event) => {
    // A failed <img>/<script> load also fires this, with no `error` object. Those are not
    // exceptions and would fill the log with noise.
    if (!event.error && !event.message) return

    send(
      'exception',
      event.error instanceof Error ? event.error.message : String(event.message),
      event.error instanceof Error ? (event.error.stack ?? null) : null,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : null
    )
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    send(
      'rejection',
      reason instanceof Error ? reason.message : String(reason),
      reason instanceof Error ? (reason.stack ?? null) : null,
      null
    )
  })
}
