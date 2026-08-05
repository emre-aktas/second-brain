import { useMemo } from 'react'
import { useApp } from '@/store/app'

/**
 * Whether motion should be suppressed.
 *
 * The app's own setting, or the operating system's — either one is a request to stop, and
 * honouring only the app's would ignore a preference the user has already stated once for
 * every program on the machine.
 *
 * A hook rather than a value passed down, because this had been computed inline in `App` and
 * anything else that needed it had no way to reach it except by growing another prop. The
 * `matchMedia` read is memoised on mount: a preference that changes mid-session is rare
 * enough that reacting to it is not worth a listener in every component.
 */
export function useReduceMotion(): boolean {
  const setting = useApp((s) => s.settings?.appearance.reduceMotion ?? false)
  const system = useMemo(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  )
  return setting || system
}
