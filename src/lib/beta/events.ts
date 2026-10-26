/**
 * The only analytics this install has.
 *
 * Everything else in the beta funnel is derived from rows the app already
 * writes for its own reasons — requests, invites, mailboxes, threads. These
 * five events are the exceptions: things that leave no trace anywhere, and
 * which a separate store would otherwise be invented to capture.
 *
 * `ProductEventName` is a closed union, so this cannot become a general-purpose
 * tracker by accident. Nothing recorded here may contain a subject, a sender, a
 * body, a topic, or a third party's address: a row is a user, a name, a
 * timestamp, and at most a conversation id.
 */

import { randomUUID } from 'node:crypto'

import { db } from '#/db/index.ts'
import { productEvents } from '#/db/schema.ts'
import type { ProductEventName } from '#/db/schema.ts'

export type { ProductEventName }

/**
 * Which sessions have already recorded today.
 *
 * In memory for the same reason the throttles are: one Bun process. A restart
 * costs at most one duplicate `active-day` row, which is a nicer failure than a
 * lookup on every request.
 */
const seenToday = new Map<string, string>()

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export async function recordEvent(
  name: ProductEventName,
  userId: string,
  conversationId?: string | null,
): Promise<void> {
  try {
    await db.insert(productEvents).values({
      id: randomUUID(),
      userId: userId.toLowerCase(),
      name,
      conversationId: conversationId ?? null,
    })
  } catch (error) {
    // Never let measurement break the thing being measured: a failed insert is
    // a missing data point, not a failed request.
    console.warn('[beta] could not record', name, error)
  }
}

/**
 * One row per session per day, written on the first authenticated request.
 *
 * `sessions.last_seen_at` only holds the *latest* touch, so "did they come
 * back on a different day" cannot be answered from it — which is exactly the
 * question the returned-users step asks.
 */
export async function recordActiveDay(
  sessionId: string,
  userId: string,
): Promise<void> {
  const today = dayKey(new Date())
  if (seenToday.get(sessionId) === today) return

  // Bound the map: a session id is never seen again after it expires, and this
  // process had better not grow one entry per device forever.
  if (seenToday.size > 5_000) seenToday.clear()

  seenToday.set(sessionId, today)
  await recordEvent('active-day', userId)
}
