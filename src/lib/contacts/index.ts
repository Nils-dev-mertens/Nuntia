/**
 * Contact enrichment.
 *
 * The address book is the mail itself. Every message header carries a display
 * name, and the contacts table keeps the most recent one per `(mailbox,
 * address)`, so a thread from a person the user has corresponded with shows a
 * name even when the newest message omitted it.
 *
 * There is no third-party lookup: names come from the user's own mail, and the
 * one external surface — Gravatar — is opt-in and sends nothing but a hash of
 * the address. Initials are the always-available fallback.
 */

import { createHash } from 'node:crypto'

import { asc, desc, inArray } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { contacts } from '#/db/schema.ts'

import { normaliseContactEmail } from './matching.ts'

export type ContactParticipant = { name?: string | null; email: string }

export type EnrichedParticipant = {
  name: string | null
  email: string
  /** One or two letters for the avatar circle. Never empty. */
  initials: string
  /** Gravatar image URL, or null when avatars are off or no address exists. */
  avatarUrl: string | null
}

// Pure helpers, re-exported so server callers keep one import. The composer
// imports `matching.ts` directly to stay out of the database.
export { matchContactSuggestions, normaliseContactEmail } from './matching.ts'

/**
 * One or two initials for an avatar.
 *
 * A name wins because it is what the user recognises; the address is the
 * fallback so a row is never blank. Multi-part names use the first and last
 * word, which is what every address book does.
 */
export function initialsOf(
  name: string | null | undefined,
  email: string,
): string {
  const words = (name ?? '')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)

  if (words.length > 0) {
    const first = words[0]?.at(0) ?? ''
    const last = words.length > 1 ? (words.at(-1)?.at(0) ?? '') : ''
    return (first + last).toUpperCase()
  }

  const local = email.split('@')[0] ?? ''
  return (local.at(0) ?? '?').toUpperCase()
}

/**
 * Gravatar URL for an address.
 *
 * `d=404` rather than a default image: the UI already draws initials, and a
 * generic silhouette from gravatar.com would be a worse fallback that still
 * contacted the network. An address with no Gravatar therefore fails to load and
 * the initials stay visible.
 */
export function gravatarUrl(email: string): string {
  const hash = createHash('md5')
    .update(normaliseContactEmail(email))
    .digest('hex')
  return `https://www.gravatar.com/avatar/${hash}?d=404&s=64`
}

/**
 * Names learned from stored mail, for the mailboxes given.
 *
 * One query for every mailbox, keyed by lowercased address. The table is written
 * oldest-first on read so the newest spelling wins when two mailboxes know the
 * same person differently.
 */
export async function contactNamesFor(
  accountIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (accountIds.length === 0) return names

  const rows = await db
    .select()
    .from(contacts)
    .where(inArray(contacts.accountId, accountIds))
    .orderBy(asc(contacts.updatedAt))

  for (const row of rows) {
    if (row.name?.trim()) names.set(row.email, row.name.trim())
  }

  return names
}

/**
 * Addresses the user has exchanged mail with, newest first.
 *
 * The recipient list the composer offers. Everything comes from the mail itself —
 * the contacts table is written from every thread's participants — so this is
 * exactly "people I have sent to or heard from", and the user's own addresses are
 * excluded because mailing yourself is an accident rather than a habit.
 *
 * Deduplicated by address across mailboxes: the same person writing to two of
 * them is one suggestion, carrying the newest name known for them.
 */
export type ContactSuggestion = {
  email: string
  name: string | null
  /** The mailbox the address was last seen on. */
  accountId: string
  lastUsedAt: Date
}

export async function listContactSuggestions(
  accountIds: string[],
  excludeEmails: Iterable<string>,
  limit = 150,
): Promise<ContactSuggestion[]> {
  if (accountIds.length === 0) return []

  const excluded = new Set(
    [...excludeEmails].map((email) => normaliseContactEmail(email)),
  )

  const rows = await db
    .select()
    .from(contacts)
    .where(inArray(contacts.accountId, accountIds))
    .orderBy(desc(contacts.updatedAt))

  const seen = new Set<string>()
  const out: ContactSuggestion[] = []

  for (const row of rows) {
    const email = normaliseContactEmail(row.email)
    if (!email || excluded.has(email) || seen.has(email)) continue

    seen.add(email)
    out.push({
      email: row.email.trim(),
      name: row.name?.trim() || null,
      accountId: row.accountId,
      lastUsedAt: row.updatedAt,
    })

    if (out.length >= limit) break
  }

  return out
}

/**
 * Remember addresses the user sent to.
 *
 * Synced mail teaches the address book on its own, but a send does not wait for
 * the next sync: Gmail's refresh can fail, and Graph reports no thread at all, so
 * without this a person written to once from Outlook would never be offered by
 * name next time. Only called after the provider accepted the message, so a
 * refused send cannot leave a contact behind.
 *
 * Names are left alone — nothing here knows one — and an existing name survives,
 * which is what lets a later nameless sighting keep what mail already taught.
 */
export async function recordContactedAddresses(
  accountId: string,
  emails: Iterable<string>,
): Promise<void> {
  const now = new Date()
  const rows = [
    ...new Set(
      [...emails]
        .map((email) => normaliseContactEmail(email))
        .filter((email) => email.length > 0),
    ),
  ].map((email) => ({ accountId, email, updatedAt: now }))

  if (rows.length === 0) return

  await db
    .insert(contacts)
    .values(rows)
    .onConflictDoUpdate({
      target: [contacts.accountId, contacts.email],
      set: { updatedAt: now },
    })
}

/**
 * Fill in names and avatars for a conversation's participants.
 *
 * A participant's own name beats a learned one: the newest message is the most
 * current thing the app has seen, and the contacts row only exists to stop a
 * later nameless message from erasing it.
 */
export function enrichParticipants(
  participants: ContactParticipant[],
  names: Map<string, string>,
  useGravatar: boolean,
): EnrichedParticipant[] {
  return participants.map((participant) => {
    const email = normaliseContactEmail(participant.email)
    const own = participant.name?.trim() || null
    const name = own ?? names.get(email) ?? null

    return {
      name,
      email: participant.email,
      initials: initialsOf(name, participant.email),
      avatarUrl: useGravatar && email ? gravatarUrl(email) : null,
    }
  })
}
