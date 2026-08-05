import { Command as CommandPrimitive } from 'cmdk'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cn } from '@/lib/utils'

export const Command = CommandPrimitive
export const CommandInput = CommandPrimitive.Input
export const CommandEmpty = CommandPrimitive.Empty

/**
 * The palette opens on a keyboard shortcut, dozens of times a day, so it does
 * not animate at all. An animation here would add perceived latency to the one
 * interaction that most needs to feel instant.
 */
export function CommandDialog({
  open,
  onOpenChange,
  children,
  label = 'Command palette'
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  label?: string
}): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <DialogPrimitive.Content
          aria-label={label}
          className="fixed left-1/2 top-[18%] z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function CommandInputRow({
  value,
  onValueChange,
  placeholder
}: {
  value: string
  onValueChange: (value: string) => void
  placeholder: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-4">
      <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <CommandPrimitive.Input
        value={value}
        onValueChange={onValueChange}
        placeholder={placeholder}
        className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
      />
    </div>
  )
}

export function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>): React.JSX.Element {
  return (
    <CommandPrimitive.List
      className={cn('max-h-[60vh] overflow-y-auto overflow-x-hidden p-1.5', className)}
      {...props}
    />
  )
}

export function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>): React.JSX.Element {
  return (
    <CommandPrimitive.Group
      className={cn(
        'overflow-hidden py-1',
        '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-1.5',
        '[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold',
        '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider',
        '[&_[cmdk-group-heading]]:text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}

export function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>): React.JSX.Element {
  return (
    <CommandPrimitive.Item
      className={cn(
        'relative flex cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none',
        'text-foreground',
        'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
        'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground data-[selected=true]:[&_svg]:text-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

export function CommandSeparator(): React.JSX.Element {
  return <CommandPrimitive.Separator className="my-1 h-px bg-border" />
}
