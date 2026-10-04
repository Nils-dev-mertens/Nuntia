import { cn } from '#/lib/utils'
import { STATE_META } from '#/lib/conversation-state'
import type { ConversationState } from '#/db/schema'

export function StateBadge({
  state,
  className,
}: {
  state: ConversationState
  className?: string
}) {
  const meta = STATE_META[state]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        meta.badgeClass,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('size-1.5 rounded-full', meta.dotClass)}
      />
      {meta.label}
    </span>
  )
}