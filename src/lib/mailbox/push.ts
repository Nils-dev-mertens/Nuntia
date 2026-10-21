/**
 * Push notifications, with polling as the fallback.
 *
 * Gmail can tell this app when a mailbox changes (`users.watch` → a Pub/Sub
 * topic → an HTTPS push subscription). Two properties shape the code:
 *
 * 1. **The registration expires.** Gmail caps it at seven days, so the expiry is
 *    stored per account and renewed from the inbox load, which is the one place
 *    that already runs on every visit. A failed renewal is not an error the user
 *    sees — the poll is still there, and it is what the app uses on a localhost
 *    install where Google has nowhere to deliver to.
 * 2. **The notification carries an address, not an id.** Pub/Sub only says which
 *    mailbox changed, so the account is resolved by email and scoped to its
 *    owner; an address this install does not hold is ignored rather than
 *    guessed at.
 *
 * Outlook is not registered here: Graph change notifications need their own
 * subscription lifetime, client state and renewal, and the poll already covers
 * it. Claiming otherwise would be worse than the missing feature.
 */

import {
  findAccountByEmail,
  getPushExpiresAt,
  setPushExpiresAt,
} from '#/lib/auth/accounts.ts'
import { createMailboxClientFor } from './provider.ts'

/** Renew this long before the registration lapses. */
const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000

/** Don't retry a failed registration more often than this. */
const RETRY_AFTER_MS = 10 * 60 * 1000

/** Last registration attempt per account, so a page load cannot hammer Google. */
const lastAttemptAt = new Map<string, number>()

/** The Pub/Sub topic Gmail should publish to, or null when unconfigured. */
export function pushTopic(): string | null {
  const topic = process.env.GOOGLE_PUBSUB_TOPIC?.trim()
  return topic ? topic : null
}

/**
 * Shared secret the push endpoint requires.
 *
 * Pub/Sub cannot attach our session, and OIDC verification needs a service
 * account the user may not have. A long random token in the subscription URL is
 * the honest minimum; without one the endpoint stays closed.
 */
export function pushToken(): string | null {
  const token = process.env.GMAIL_PUSH_TOKEN?.trim()
  return token ? token : null
}

/** True when this install can receive push at all. */
export function pushConfigured(): boolean {
  return pushTopic() !== null && pushToken() !== null
}

export type GmailPushNotification = {
  /** The mailbox the notification is about. */
  email: string
  /** Gmail's cursor at the moment of the change, when it sent one. */
  historyId: string | null
}

/**
 * Read a Pub/Sub push envelope.
 *
 * Two shapes are accepted: the delivery body (`message.data`, base64) and the
 * decoded notification itself. The second makes the handler testable and lets a
 * local tunnel forward either form. Anything else is null — an unrecognised body
 * must not be treated as "some mailbox changed".
 */
export function parseGmailPushNotification(
  payload: unknown,
): GmailPushNotification | null {
  if (!payload || typeof payload !== 'object') return null

  const envelope = payload as {
    message?: { data?: unknown }
    emailAddress?: unknown
    historyId?: unknown
  }

  let notification: { emailAddress?: unknown; historyId?: unknown } | null =
    null

  if (typeof envelope.message?.data === 'string') {
    try {
      notification = JSON.parse(
        Buffer.from(envelope.message.data, 'base64').toString('utf-8'),
      ) as { emailAddress?: unknown; historyId?: unknown }
    } catch {
      return null
    }
  } else if (typeof envelope.emailAddress === 'string') {
    notification = envelope
  }

  if (!notification) return null

  const email =
    typeof notification.emailAddress === 'string'
      ? notification.emailAddress.trim().toLowerCase()
      : ''
  if (!email) return null

  const historyId =
    typeof notification.historyId === 'string' ||
    typeof notification.historyId === 'number'
      ? String(notification.historyId)
      : null

  return { email, historyId }
}

/**
 * The mailbox a notification is about, or null when this install does not hold
 * it (or its owner has since been removed or disconnected).
 */
export async function resolveGmailPushTarget(
  payload: unknown,
): Promise<{ userId: string; accountId: string; email: string } | null> {
  const notification = parseGmailPushNotification(payload)
  if (!notification) return null

  const account = await findAccountByEmail(notification.email)
  if (!account || account.provider !== 'google') return null
  if (!account.userId) return null

  return { userId: account.userId, accountId: account.id, email: account.email }
}

/**
 * Register or renew the push watch for every Google mailbox that needs it.
 *
 * Cheap when nothing is due: one indexed read per account. Called on each inbox
 * load and never awaited by it.
 */
export async function ensurePushRegistrations(
  userId: string,
  accounts: Array<{ id: string; provider: string }>,
): Promise<void> {
  const topic = pushTopic()
  if (!topic) return

  const now = Date.now()

  for (const account of accounts) {
    if (account.provider !== 'google') continue

    const expiresAt = await getPushExpiresAt(account.id)
    if (expiresAt && expiresAt.getTime() - now > RENEW_WITHIN_MS) continue

    const attempted = lastAttemptAt.get(account.id) ?? 0
    if (now - attempted < RETRY_AFTER_MS) continue
    lastAttemptAt.set(account.id, now)

    try {
      const client = await createMailboxClientFor(account.id)
      if (!client?.startWatch) continue

      const { expiresAt: next } = await client.startWatch({ topicName: topic })
      await setPushExpiresAt(account.id, next)
      console.log(
        `[push] watching ${account.id} until ${next.toISOString()} (user ${userId})`,
      )
    } catch (error) {
      // A missing `pubsub.topics.publish` grant or a revoked token lands here.
      // Clearing the stored expiry makes the next load try again.
      await setPushExpiresAt(account.id, null).catch(() => {})
      console.warn(`[push] could not watch ${account.id}:`, error)
    }
  }
}

/** Forget the retry throttle. Exported for tests. */
export function resetPushThrottle(): void {
  lastAttemptAt.clear()
}
