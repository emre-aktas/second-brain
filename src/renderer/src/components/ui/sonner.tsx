import { Toaster as SonnerToaster, toast } from 'sonner'

export function Toaster(): React.JSX.Element {
  return (
    <SonnerToaster
      position="bottom-left"
      // Offset clears the graph controls in the opposite corner and the status bar.
      offset={16}
      gap={8}
      closeButton
      toastOptions={{
        classNames: {
          toast:
            'group !rounded-lg !border-border !bg-popover !text-popover-foreground !shadow-lg !font-sans',
          title: '!text-[13px] !font-medium',
          description: '!text-[13px] !text-muted-foreground',
          actionButton: '!bg-primary !text-primary-foreground !rounded-md !text-xs',
          cancelButton: '!bg-secondary !text-secondary-foreground !rounded-md !text-xs',
          closeButton: '!bg-popover !border-border !text-muted-foreground'
        }
      }}
    />
  )
}

export { toast }
