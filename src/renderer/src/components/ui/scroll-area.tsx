import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import { cn } from '@/lib/utils'

export function ScrollArea({
  className,
  children,
  viewportRef,
  onViewportScroll,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportRef?: React.Ref<HTMLDivElement>
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>
}): React.JSX.Element {
  return (
    <ScrollAreaPrimitive.Root className={cn('relative overflow-hidden', className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        onScroll={onViewportScroll}
        className="h-full w-full rounded-[inherit] [&>div]:!block"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <Scrollbar orientation="vertical" />
      <Scrollbar orientation="horizontal" />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function Scrollbar({ orientation }: { orientation: 'vertical' | 'horizontal' }): React.JSX.Element {
  return (
    <ScrollAreaPrimitive.Scrollbar
      orientation={orientation}
      className={cn(
        'flex touch-none select-none p-0.5 transition-colors duration-150',
        orientation === 'vertical' ? 'h-full w-2.5' : 'h-2.5 flex-col'
      )}
    >
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-muted-foreground/25 transition-colors duration-150 hover:bg-muted-foreground/45" />
    </ScrollAreaPrimitive.Scrollbar>
  )
}
