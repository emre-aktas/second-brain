import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
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
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    /**
     * Grow with the content rather than scrolling inside a fixed box.
     *
     * Opt-in, because a form field of a known size should stay that size — this is for the
     * one field whose whole job is not knowing in advance how much will be typed into it.
     */
    autoGrow?: boolean
    /** Tallest it may get, in CSS pixels. Past this it scrolls, as before. */
    maxHeight?: number
    /**
     * No border, no background, no focus ring of its own.
     *
     * For a field that sits *inside* a surface which already owns all three. Without it the
     * composer was a box inside a box, and the outer one could not show focus because the
     * inner one had taken the ring.
     */
    bare?: boolean
  }
>(function Textarea(
  { className, autoGrow = false, maxHeight = 240, bare = false, ...props },
  ref
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)

  const measure = useCallback(() => {
    const element = innerRef.current
    if (!element || !autoGrow) return

    // Released first. `scrollHeight` reports the content height only when the box is not
    // already holding it open, so measuring without this can grow but never shrink —
    // deleting a paragraph would leave the field the size it had reached.
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`
    element.style.overflowY = element.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [autoGrow, maxHeight])

  // After layout, not after paint: measuring in `useEffect` lets the browser show one frame
  // at the old height, which is a visible flicker on every keystroke that changes the line
  // count.
  useLayoutEffect(measure, [measure, props.value])

  useEffect(() => {
    const element = innerRef.current
    if (!autoGrow || !element || typeof ResizeObserver === 'undefined') return

    // The panel this sits in is resizable, so the same text wraps to a different number of
    // lines without the value changing at all.
    //
    // Width only. A ResizeObserver on this element also fires for the height *we* just set,
    // and re-measuring on that is a loop.
    let lastWidth = -1
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? -1
      if (Math.abs(width - lastWidth) < 0.5) return
      lastWidth = width
      measure()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [autoGrow, measure])

  return (
    <textarea
      ref={(element) => {
        innerRef.current = element
        if (typeof ref === 'function') ref(element)
        else if (ref) ref.current = element
      }}
      className={cn(
        bare
          ? [
              'w-full resize-none bg-transparent text-sm text-foreground outline-none',
              'placeholder:text-muted-foreground/70',
              'disabled:cursor-not-allowed disabled:opacity-50'
            ].join(' ')
          : fieldBase,
        'resize-none px-3 py-2 leading-relaxed',
        // A single line of text. The controls live below it now rather than floating over
        // it, so this no longer has to reserve room for them.
        autoGrow ? 'min-h-[26px]' : 'min-h-20',
        className
      )}
      {...props}
    />
  )
})
