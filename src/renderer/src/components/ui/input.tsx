import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

const fieldBase = [
  'w-full rounded-md border border-input bg-transparent text-sm text-foreground',
  'placeholder:text-muted-foreground/70',
  'transition-[border-color,box-shadow] duration-150 ease-[var(--ease-out)]',
  'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25',
  'disabled:cursor-not-allowed disabled:opacity-50'
].join(' ')

// Forwarded refs so callers can focus a field — a tool summoned by its global
// shortcut has to land the cursor where the user is about to type.
export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type = 'text', ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(fieldBase, 'h-9 px-3 py-1.5', className)}
        {...props}
      />
    )
  }
)

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(fieldBase, 'min-h-20 resize-none px-3 py-2 leading-relaxed', className)}
      {...props}
    />
  )
})
