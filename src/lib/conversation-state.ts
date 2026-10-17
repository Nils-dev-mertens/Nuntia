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

/**
 * The two marks the user owns, and the words for them.
 *
 * They are easy to confuse — one is a fact the app noticed, the other is a
 * decision the user made — so the copy lives in one place rather than being
 * re-worded per view. **New** is mail you have not opened; **Done** is what you
 * decided about mail you have opened. Opening a thread clears the first and can
 * never set the second.
 */
export const READ_META = {
  label: 'New',
  /** The dot's tooltip, and its accessible name. */
  description: 'Mail you have not opened yet. Opening the thread clears it.',
} as const

export const DONE_META = {
  label: 'Done',
  /** Tooltip wherever the tag appears. */
  description: 'You handled this. New mail brings it back on its own.',
  /**
   * Shown on the thread itself, where there is room to say what the mark does
   * rather than only what it means.
   */
  detail:
    'You marked this handled, so it is out of the open groups in the inbox. New mail brings it back by itself.',
} as const

/** The inbox section done threads move to, and the line under its heading. */
export const DONE_GROUP = {
  label: 'Done',
  description:
    'Handled by you, so no longer among the work below. The state each thread had is kept and shown faintly — new mail moves it back by itself.',
} as const

export function isConversationState(value: unknown): value is ConversationState {
  return (
    typeof value === 'string' && value in STATE_META
  )
}