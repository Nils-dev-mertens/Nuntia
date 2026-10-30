import { cn } from '#/lib/utils'
import { STATE_META } from '#/lib/conversation-state'
import type { ConversationState } from '#/db/schema'

/**
 * A conversation's label: a dot and words, not a pill.
 *
 * The colour is carried by the dot alone and the text keeps the row's colour. A
 * filled, bordered badge on every card turned the list into a strip of stickers,
 * and the label is orientation rather than decoration. The words are still the
 * user's (`label`), because the state is fixed but its name is not.
 */
export function StateBadge({
  state,
  label,
  className,
}: {
  state: ConversationState
  /**
   * The user's name for this label, when they have given it one. The state — and
   * therefore the colour — is fixed; only the words are theirs.
   */
  label?: string
  className?: string
}) {
  const meta = STATE_META[state]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] font-medium text-foreground',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('size-1.5 shrink-0 rounded-full', meta.dotClass)}
      />
      {label ?? meta.label}
    </span>
  )
}
