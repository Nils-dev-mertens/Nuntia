import type { ConversationState } from '#/db/schema'

/**
 * Presentation config for the four conversation states.
 *
 * Colours come from ReUI's semantic tokens (see styles.css), which is why we
 * chose ReUI over stock shadcn: the states map 1:1 onto the token set.
 */
export const STATE_META: Record<
  ConversationState,
  { label: string; badgeClass: string; dotClass: string; description: string }
> = {
  'needs-action': {
    label: 'Needs action',
    badgeClass: 'bg-success/15 text-success border-success/30',
    dotClass: 'bg-success',
    description: 'You are expected to do something.',
  },
  'waiting-for-reply': {
    label: 'Waiting for reply',
    badgeClass: 'bg-warning/15 text-warning border-warning/30',
    dotClass: 'bg-warning',
    description: 'You replied and are waiting on someone else.',
  },
  informational: {
    label: 'Informational',
    badgeClass: 'bg-info/15 text-info border-info/30',
    dotClass: 'bg-info',
    description: 'No action is currently required.',
  },
  'low-priority': {
    label: 'Low priority',
    badgeClass: 'bg-muted text-muted-foreground border-border',
    dotClass: 'bg-muted-foreground',
    description: 'Does not currently require attention.',
  },
}

/** Display order in the inbox — what needs doing first, not chronological. */
export const STATE_ORDER: ConversationState[] = [
  'needs-action',
  'waiting-for-reply',
  'informational',
  'low-priority',
]

export function isConversationState(value: unknown): value is ConversationState {
  return (
    typeof value === 'string' && value in STATE_META
  )
}