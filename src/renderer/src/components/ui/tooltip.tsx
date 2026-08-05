import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'

/**
 * `skipDelayDuration` is what makes a toolbar feel fast: the first tooltip waits,
 * but moving to a neighbouring control shows its tooltip immediately.
 */
export function TooltipProvider({
  children,
  delayDuration = 320
}: {
  children: React.ReactNode
  delayDuration?: number
}): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={280}>
      {children}
    </TooltipPrimitive.Provider>
  )
}

export function Tooltip({
  children,
  content,
  side = 'top',
  align = 'center',
  hidden
}: {
  children: React.ReactNode
  content: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  hidden?: boolean
}): React.JSX.Element {
  if (hidden) return <>{children}</>

  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            'z-50 max-w-64 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md',
            // Scaling from the trigger rather than from the centre is the detail
            // that makes a popover feel attached to what opened it.
            'origin-[var(--radix-tooltip-content-transform-origin)]',
            'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out',
            'data-[state=delayed-open]:fade-in-0 data-[state=closed]:fade-out-0',
            'data-[state=delayed-open]:zoom-in-95 data-[state=closed]:zoom-out-95',
            'duration-125'
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
