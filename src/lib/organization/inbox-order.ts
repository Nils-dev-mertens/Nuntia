/**
 * The inbox's section order.
 *
 * One flat list of tokens — the four AI groups plus the user's custom labels —
 * because the point is that a label can sit *between* two AI groups. Tokens are
 * namespaced, so a label id can never collide with a state.
 *
 * Done is deliberately not in the list: a finished thread is filed away and its
 * section is always last, so there is nothing to arrange about it.
 */

import type { ConversationState } from '#/db/schema.ts'

import { STATE_ORDER } from '#/lib/conversation-state.ts'

/** A section in the user's arrangement: one of the four states or a label. */
export type InboxSectionToken = string

/**
 * Upper bound on a stored order.
 *
 * The rules are capped at 50 and there are four states, so this is generous;
 * it exists to refuse an unbounded array from the browser rather than to limit
 * anything a real inbox would use.
 */
export const INBOX_ORDER_LIMIT = 200

export function stateToken(state: ConversationState): InboxSectionToken {
  return `state:${state}`
}

export function labelToken(labelId: string): InboxSectionToken {
  return `label:${labelId}`
}

/**
 * The order before the user has arranged anything.
 *
 * Needs action first because it is the work; the labels next because they are
 * the user's own filing of that work; then the remaining groups. This is the
 * same shape the inbox had before the order was editable, so an install that
 * never drags anything reads as it did.
 */
export function defaultInboxOrder(labelIds: string[]): InboxSectionToken[] {
  return [
    stateToken('needs-action'),
    ...labelIds.map(labelToken),
    ...STATE_ORDER.filter((state) => state !== 'needs-action').map(stateToken),
  ]
}

/**
 * A stored order made valid for the labels the user has now.
 *
 * Unknown tokens are dropped (a label that was deleted), duplicates collapsed,
 * and anything missing appended after what was stored — so a label created after
 * the order was saved still appears instead of being invisible. Invalid input is
 * treated as no preference rather than as an error: this runs on every inbox
 * load, and a malformed value must not blank the arrangement.
 */
export function resolveInboxOrder(
  stored: unknown,
  labelIds: string[],
): InboxSectionToken[] {
  const valid = new Set([
    ...STATE_ORDER.map(stateToken),
    ...labelIds.map(labelToken),
  ])
  const seen = new Set<InboxSectionToken>()
  const order: InboxSectionToken[] = []

  if (Array.isArray(stored)) {
    for (const token of stored) {
      if (typeof token !== 'string' || !valid.has(token) || seen.has(token)) {
        continue
      }
      seen.add(token)
      order.push(token)
      if (order.length >= INBOX_ORDER_LIMIT) break
    }
  }

  for (const token of defaultInboxOrder(labelIds)) {
    if (seen.has(token)) continue
    seen.add(token)
    order.push(token)
  }

  return order
}
