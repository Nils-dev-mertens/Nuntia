/**
 * Telling machines from people.
 *
 * A no-reply address is not a conversation. Rendering "build #881 failed" as chat
 * bubbles is actively misleading — it implies turn-taking with a human, offers a
 * reply box that goes nowhere, and files a receipt under "waiting for reply".
 *
 * This module answers one question: is there a human on the other side?
 *
 * Two deliberate choices:
 *
 * **Strict, and only explicit markers.** No list of "known" services, no
 * inference from message volume or tone. A false positive hides a real person's
 * mail from chat view, which is worse than showing a robot as a chat. The cost is
 * that some automated senders stay in chat view — visible, just not ideal.
 *
 * **Derived per thread, not per address.** See `isAutomatedThread`.
 */

import type { Participant } from '#/db/schema.ts'

import type { ConversationMessage } from './model.ts'

/**
 * Address markers that mean "a machine sent this".
 *
 * Deliberately excludes bare `reply` and bare `auto`: both show up in real
 * personal addresses (`reply@`, `auto@`) and neither is worth the false positive.
 * Compounds like `do-not-reply` *are* listed, because they only appear
 * deliberately.
 */
const AUTOMATED_LOCAL_MARKERS = new Set([
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'do-not-respond',
  'dont-reply',
  'mailer-daemon',
  'mail-daemon',
  'postmaster',
  'bounce',
  'bounces',
  'notification',
  'notifications',
  'automated',
  'autoreply',
  'auto-reply',
  'alert',
  'alerts',
])

/**
 * Display-name markers, for senders that use a friendly name instead.
 *
 * "GitHub (no-reply)" is the common shape — the address is often a real
 * person's, and only the display name says otherwise.
 *
 * Only phrases that are unambiguous as English are listed. Bare `alert`,
 * `alerts`, `notification` and `automatic` are **not**: "Alerts Department" and
 * "Automatic Payroll Ltd" are ordinary company names, and a substring match
 * files them as machines. Those senders are still caught on their address, which
 * is nearly always `alerts@` or `notifications@`.
 */
const AUTOMATED_NAME_PATTERNS = [
  'no-reply',
  'no reply',
  'noreply',
  'do not reply',
  "don't reply",
  'do-not-reply',
  'do not respond',
  'cannot be replied',
  'cannot reply',
  'automated',
  'mailer-daemon',
  'mail delivery subsystem',
]

/** Lowercase and trim. */
function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Flatten the local part so separators do not defeat the markers.
 *
 * `.`, `-`, `_` and `+` all collapse to `-`, which is what lets `no_reply`,
 * `no.reply` and `noreply+ci` match the same entry. The host is discarded —
 * `no-reply.github.com` is an *outbound* bounce domain used by Gmail, not a
 * sender, and matching on it would flag unrelated human mail.
 */
function normalizeLocalPart(email: string): string {
  const local = normalize(email).split('@')[0] ?? ''
  return local.replace(/[._+]+/g, '-').replace(/-+/g, '-')
}

/**
 * Does the local part carry a marker, allowing for a service prefix or suffix?
 *
 * `github-noreply` and `stripe-no-reply` are real and common, so a marker
 * matches at either end — but only on a separator boundary. Matching anywhere in
 * the string would flag `nora.reilly@` as automated, which is exactly the false
 * positive this module exists to avoid.
 */
function localPartIsAutomated(email: string): boolean {
  const local = normalizeLocalPart(email)
  if (!local) return false

  for (const marker of AUTOMATED_LOCAL_MARKERS) {
    if (local === marker) return true
    if (local.startsWith(`${marker}-`)) return true
    if (local.endsWith(`-${marker}`)) return true
  }

  return false
}

/**
 * Does this single address carry an explicit automation marker?
 *
 * Exported for testing and for a future per-address override UI; thread-level
 * decisions go through `isAutomatedThread`, which is what the app calls.
 */
export function isAutomatedSender(participant: Participant): boolean {
  // The display name is checked first: "GitHub (no-reply)" should win even if the
  // address behind it is a person's.
  if (participant.name) {
    const name = normalize(participant.name)
    if (AUTOMATED_NAME_PATTERNS.some((pattern) => name.includes(pattern))) {
      return true
    }
  }

  return localPartIsAutomated(participant.email)
}

/**
 * Is this thread machine-generated?
 *
 * The rule: **every** message came from either the account owner or a marked
 * sender, **and** at least one came from a marked sender.
 *
 * Both halves matter:
 *
 * - The "at least one" guard stops a thread you only ever wrote yourself — a
 *   draft sent to yourself, an alias — from being called automated, when nothing
 *   machine-generated happened there at all.
 * - The "every" guard is what makes this self-correcting. If a human ever replies
 *   to `noreply@github.com`, the thread becomes a chat again on the next sync.
 *   Nothing needs overriding or undoing, because nothing was persisted as a
 *   permanent label — it is re-derived from the messages every time.
 *
 * The owner is excluded by address rather than by the message's `isFromOwner`
 * flag, because that flag is itself produced by comparing against a normalized
 * address, and repeating the comparison here keeps this function independent of
 * how the parser resolved it.
 *
 * Takes a *set* of owner addresses because an install can have several connected
 * mailboxes: a thread you wrote from one address and received on another is still
 * yours, and excluding only one of them would count your own reply as a human's.
 */
export function isAutomatedThread(
  messages: Array<Pick<ConversationMessage, 'from'>>,
  ownerEmails: string | readonly string[],
): boolean {
  if (messages.length === 0) return false

  const ownerList =
    typeof ownerEmails === 'string' ? [ownerEmails] : [...ownerEmails]
  const owners = new Set(ownerList.map(normalize))
  let sawAutomatedSender = false

  for (const message of messages) {
    if (owners.has(normalize(message.from.email))) continue

    if (!isAutomatedSender(message.from)) return false
    sawAutomatedSender = true
  }

  return sawAutomatedSender
}
