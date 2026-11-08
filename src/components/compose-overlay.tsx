/**
 * The new-message window from `design.pen`.
 *
 * The design draws composing as a window over the inbox rather than a page of
 * its own: writing a message is a detour from triage, and leaving the list lost
 * the place the user was reading. `Compose` is unchanged inside it — the same
 * recipient field, greeting preview and attachment limits.
 */

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

import { Compose } from '#/components/compose.tsx'
import type { ComposeStyle, ComposeInput } from '#/components/compose.tsx'
import type { ComposeAccount } from '#/components/compose.tsx'
import type { RecipientSuggestion } from '#/components/recipient-field.tsx'

export function ComposeOverlay({
  open,
  onClose,
  accounts,
  suggestions,
  loadStyle,
  submit,
}: {
  open: boolean
  onClose: () => void
  accounts: ComposeAccount[]
  suggestions: RecipientSuggestion[]
  loadStyle: (input: {
    accountId: string
    recipient: string | null
  }) => Promise<ComposeStyle>
  submit: (input: ComposeInput) => Promise<{
    error: string | null
    threadId: string | null
  }>
}) {
  const panel = useRef<HTMLDivElement>(null)
  // Held in a ref: the parent passes a fresh closure on every render, and the
  // focus setup below must not re-run (and re-focus) on each of those.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return

    const previous = document.activeElement as HTMLElement | null
    const focusable = () =>
      [
        ...(panel.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([type="file"]):not([disabled])',
        ) ?? []),
      ].filter((element) => element.offsetParent !== null)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      // Trapped: Tab belongs to the window while it is open.
      const items = focusable()
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    // A dialog over a scrolling list would still scroll the list underneath.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)

    // Straight to the recipient: the window exists to write to someone, so
    // clicking the first field first is a step with nothing in it.
    panel.current
      ?.querySelector<HTMLInputElement>('input:not([type="file"])')
      ?.focus()

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New message"
      onMouseDown={(event) => {
        // Only a click on the backdrop closes: a drag that starts inside the
        // window and ends out here is a text selection, not a dismissal.
        if (event.target === event.currentTarget) onClose()
      }}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-3 backdrop-blur-sm sm:p-8"
    >
      <div
        ref={panel}
        className="my-auto w-full max-w-[560px] overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-display text-sm font-semibold text-foreground">
            New message
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-[4px] p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="max-h-[calc(100vh-9rem)] overflow-y-auto">
          {accounts.length === 0 ? (
            <p className="px-4 py-8 text-sm text-muted-foreground">
              Connect a mailbox first — a message needs somewhere to leave from.
            </p>
          ) : (
            <Compose
              accounts={accounts}
              suggestions={suggestions}
              loadStyle={loadStyle}
              submit={submit}
              embedded
            />
          )}
        </div>
      </div>
    </div>
  )
}
