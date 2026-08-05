import { useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import type { ChatImage } from '@shared/types'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'

/**
 * Images attached to a turn.
 *
 * Paste is the path that matters: a screenshot of something that looks wrong is
 * the fastest way to say what is wrong, so Ctrl+V in the composer should just
 * work. Drag-and-drop and a file picker are there for the other cases.
 */

const MAX_IMAGES = 6
const MAX_BYTES = 6 * 1024 * 1024
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export interface AttachmentError {
  message: string
}

export async function readImageFiles(
  files: File[],
  existing: number
): Promise<{ images: ChatImage[]; error: string | null }> {
  const images: ChatImage[] = []
  let error: string | null = null

  for (const file of files) {
    if (existing + images.length >= MAX_IMAGES) {
      error = `Up to ${MAX_IMAGES} images per message.`
      break
    }
    if (!ALLOWED.includes(file.type)) {
      error = `${file.name || 'That file'} is not an image this can read.`
      continue
    }
    if (file.size > MAX_BYTES) {
      error = `${file.name || 'That image'} is over 6 MB.`
      continue
    }

    const buffer = await file.arrayBuffer()
    // Chunked so a large image cannot blow the argument limit of fromCharCode.
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
    }

    images.push({
      mediaType: file.type,
      dataBase64: btoa(binary),
      name: file.name || undefined
    })
  }

  return { images, error }
}

export function AttachmentStrip({
  images,
  onRemove
}: {
  images: ChatImage[]
  onRemove: (index: number) => void
}): React.JSX.Element | null {
  if (images.length === 0) return null

  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {images.map((image, index) => (
        <div
          key={index}
          className="group relative size-14 overflow-hidden rounded-md border border-border bg-secondary"
        >
          <img
            src={`data:${image.mediaType};base64,${image.dataBase64}`}
            alt={image.name ?? `Attachment ${index + 1}`}
            className="size-full object-cover"
          />
          <button
            type="button"
            aria-label="Remove"
            onClick={() => onRemove(index)}
            className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-background/85 text-muted-foreground opacity-0 transition-[opacity,color] duration-150 hover:text-destructive group-hover:opacity-100"
          >
            <X className="size-2.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

export function AttachButton({
  onFiles,
  disabled
}: {
  onFiles: (files: File[]) => void
  disabled?: boolean
}): React.JSX.Element {
  const [id] = useState(() => `attach-${Math.random().toString(36).slice(2, 8)}`)

  return (
    <>
      <input
        id={id}
        type="file"
        accept={ALLOWED.join(',')}
        multiple
        className="hidden"
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])])
          // Cleared so picking the same file twice still fires a change.
          event.target.value = ''
        }}
      />
      <Tooltip content="Attach an image — or just paste one">
        <label
          htmlFor={id}
          aria-disabled={disabled}
          className={cn(
            'grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground',
            'transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.94]',
            'hover:bg-accent hover:text-foreground',
            disabled && 'pointer-events-none opacity-50'
          )}
        >
          <ImagePlus className="size-4" />
        </label>
      </Tooltip>
    </>
  )
}
