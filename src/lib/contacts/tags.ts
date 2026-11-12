/**
 * The user's own tags for a correspondent.
 *
 * Separate from the four context fields because they answer a different
 * question: the fields are what the app understands, a tag is what the user
 * wants to find the person by later ("investor", "school", "waiting on legal").
 *
 * Two writers, and the `source` column is what keeps them apart. The user adds
 * and removes tags by hand; an automatic profile refresh may also propose tags,
 * which land as `auto`. A refresh only ever revises its own tags — a tag the
 * user typed is theirs, so the app can neither replace nor silently reuse it,
 * and a tag the app added disappears when the mail stops supporting it.
 *
 * A tag belongs to the address, not to a mailbox: the same person is one entry
 * in the directory however many of the user's accounts they write to.
 */

import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import {
  contactTagDescriptions,
  contactTagEvents,
  contactTags,
} from '#/db/schema.ts'
import type { ContactTagEventAction, ContactTagSource } from '#/db/schema.ts'

import { normaliseContactEmail } from './matching.ts'
import {
  CONTACT_TAG_LIMITS,
  normaliseContactTag,
  normaliseContactTagDescription,
  normaliseContactTagList,
  sameContactTag,
  sortContactTags,
} from './tag-name.ts'

// The rules are re-exported so server callers keep one import, while prompt
// builders and tests reach `tag-name.ts` directly and stay out of the database.
export {
  CONTACT_TAG_LIMITS,
  normaliseContactTag,
  normaliseContactTagDescription,
  normaliseContactTagList,
  sortContactTags,
} from './tag-name.ts'

/** A stored tag with who wrote it. */
type StoredContactTag = { tag: string; source: ContactTagSource }

/** This contact's rows, oldest first, so the earliest spelling is kept. */
async function readContactTags(
  owner: string,
  address: string,
): Promise<StoredContactTag[]> {
  return db
    .select({ tag: contactTags.tag, source: contactTags.source })
    .from(contactTags)
    .where(and(eq(contactTags.userId, owner), eq(contactTags.email, address)))
    .orderBy(asc(contactTags.createdAt))
}

/**
 * Every tagged contact of this user, keyed by address.
 *
 * One query rather than one per contact: the directory shows tags on every row,
 * and asking per row would be a query per person on a page that lists a
 * thousand.
 */
export async function listContactTags(
  userId: string,
): Promise<Map<string, string[]>> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return new Map()

  const rows = await db
    .select()
    .from(contactTags)
    .where(eq(contactTags.userId, owner))
    .orderBy(asc(contactTags.createdAt))

  const byEmail = new Map<string, string[]>()
  for (const row of rows) {
    const existing = byEmail.get(row.email) ?? []
    existing.push(row.tag)
    byEmail.set(row.email, existing)
  }

  for (const [email, tags] of byEmail) {
    byEmail.set(email, sortContactTags(tags))
  }
  return byEmail
}

/** This contact's tags, in display order. */
export async function getContactTags(
  userId: string,
  email: string,
): Promise<string[]> {
  const owner = userId.trim().toLowerCase()
  const address = normaliseContactEmail(email)
  if (!owner || !address) return []

  const rows = await readContactTags(owner, address)
  return sortContactTags(rows.map((row) => row.tag))
}

/**
 * Put a tag on a contact, or take it off.
 *
 * Returns the contact's tags afterwards, so the caller renders what storage
 * actually holds rather than guessing — a refused duplicate reads as the same
 * list it already had. `null` means the input was not a usable tag at all.
 *
 * Adding a tag the app had proposed claims it: the row is already there, but who
 * wrote it matters, and from now on the user owns it and a refresh cannot revise
 * it away.
 */
export async function setContactTag(
  userId: string,
  email: string,
  value: string,
  present: boolean,
): Promise<string[] | null> {
  const owner = userId.trim().toLowerCase()
  const address = normaliseContactEmail(email)
  const tag = normaliseContactTag(value)
  if (!owner || !address || !tag) return null

  const current = await readContactTags(owner, address)

  if (!present) {
    const existing = current.find((item) => sameContactTag(item.tag, tag))
    if (!existing) return sortContactTags(current.map((item) => item.tag))

    await db
      .delete(contactTags)
      .where(
        and(
          eq(contactTags.userId, owner),
          eq(contactTags.email, address),
          eq(contactTags.tag, existing.tag),
        ),
      )
    await recordTagEvent(
      owner,
      existing.tag,
      address,
      'removed',
      existing.source,
    )
    return sortContactTags(
      current.filter((item) => item !== existing).map((item) => item.tag),
    )
  }

  const existing = current.find((item) => sameContactTag(item.tag, tag))
  if (existing) {
    if (existing.source !== 'user') {
      await db
        .update(contactTags)
        .set({ source: 'user' })
        .where(
          and(
            eq(contactTags.userId, owner),
            eq(contactTags.email, address),
            eq(contactTags.tag, existing.tag),
          ),
        )
    }
    return sortContactTags(current.map((item) => item.tag))
  }

  if (current.length >= CONTACT_TAG_LIMITS.perContact) {
    return sortContactTags(current.map((item) => item.tag))
  }

  await db
    .insert(contactTags)
    .values({ userId: owner, email: address, tag, source: 'user' })
    .onConflictDoNothing()
  await recordTagEvent(owner, tag, address, 'added', 'user')

  return sortContactTags([...current.map((item) => item.tag), tag])
}

/**
 * Reconcile the tags an automatic refresh proposed with the ones it wrote
 * before.
 *
 * Additive where it can be: a proposed tag becomes an `auto` row, a tag the user
 * already has is left exactly as it is, and an `auto` tag the mail no longer
 * supports is removed. The user's own tags are never deleted here, which is the
 * whole reason the column exists.
 *
 * Returns the tags afterwards. The caller treats a failure as a lost tag rather
 * than a failed sync.
 */
export async function applyAutoContactTags(
  userId: string,
  email: string,
  proposed: unknown,
): Promise<string[]> {
  const owner = userId.trim().toLowerCase()
  const address = normaliseContactEmail(email)
  if (!owner || !address) return []

  const tags = normaliseContactTagList(proposed)
  const current = await readContactTags(owner, address)
  const wanted = new Set(tags.map((tag) => tag.toLowerCase()))

  // Only the app's own tags are reconsidered. A user tag that happens to differ
  // from today's reading of the mail stays, because the user put it there.
  const stale = current.filter(
    (item) => item.source === 'auto' && !wanted.has(item.tag.toLowerCase()),
  )
  const missing = tags.filter(
    (tag) => !current.some((item) => sameContactTag(item.tag, tag)),
  )

  const room = Math.max(
    0,
    CONTACT_TAG_LIMITS.perContact - (current.length - stale.length),
  )
  const additions = missing.slice(0, room)

  if (stale.length === 0 && additions.length === 0) {
    return sortContactTags(current.map((item) => item.tag))
  }

  await db.transaction(async (tx) => {
    if (stale.length > 0) {
      await tx.delete(contactTags).where(
        and(
          eq(contactTags.userId, owner),
          eq(contactTags.email, address),
          inArray(
            contactTags.tag,
            stale.map((item) => item.tag),
          ),
        ),
      )
    }
    if (additions.length > 0) {
      await tx
        .insert(contactTags)
        .values(
          additions.map((tag) => ({
            userId: owner,
            email: address,
            tag,
            source: 'auto' as const,
          })),
        )
        .onConflictDoNothing()
    }
  })

  // The log is written after the transaction: an event for a change that rolled
  // back would be a lie the description refresh then reads as evidence.
  for (const item of stale) {
    await recordTagEvent(owner, item.tag, address, 'removed', 'auto')
  }
  for (const tag of additions) {
    await recordTagEvent(owner, tag, address, 'added', 'auto')
  }

  return sortContactTags([
    ...current.filter((item) => !stale.includes(item)).map((item) => item.tag),
    ...additions,
  ])
}

/** One tag across the whole address book, as the settings list shows it. */
export type ContactTagSummary = {
  tag: string
  /** What the tag is for, or null when nobody has said. */
  description: string | null
  /**
   * Who wrote that sentence; null when there is none. Only `auto` text is the
   * app's to rewrite when the membership changes.
   */
  descriptionSource: ContactTagSource | null
  /** How many contacts carry it. */
  contacts: number
  /** How many of those rows the app wrote. */
  auto: number
  /** Epoch ms of the last write to the description, or null when there is none. */
  updatedAt: number | null
  /** Epoch ms of the newest membership change, or null when there is history none. */
  lastChangeAt: number | null
  /** The newest few changes, newest first: the row's line of history. */
  recentChanges: ContactTagChange[]
}

/** One line of the tag log, as the page and the prompt read it. */
export type ContactTagChange = {
  email: string
  action: ContactTagEventAction
  source: ContactTagSource
  /** Epoch ms, because loader data crosses to the browser. */
  at: number
}

/**
 * Every row that defines a tag of this user, whether or not contacts carry it.
 *
 * A definition is a word that exists on its own: it seeds the management list, so
 * a tag can be created before anyone carries it, and it keeps its description
 * when the last contact who had it lets it go.
 */
async function readTagDefinitions(owner: string): Promise<TagDefinition[]> {
  return db
    .select({
      tag: contactTagDescriptions.tag,
      description: contactTagDescriptions.description,
      source: contactTagDescriptions.source,
      updatedAt: contactTagDescriptions.updatedAt,
    })
    .from(contactTagDescriptions)
    .where(eq(contactTagDescriptions.userId, owner))
}

/** One tag that exists independently of the contacts carrying it. */
type TagDefinition = {
  tag: string
  description: string
  source: ContactTagSource
  updatedAt: Date
}

/**
 * Append one membership change to the vocabulary's history.
 *
 * Never throws: the log is evidence for an automatic description and a line on
 * the page, not the change itself, so losing one entry must not turn a tag the
 * user just set into an error.
 */
async function recordTagEvent(
  owner: string,
  tag: string,
  email: string,
  action: ContactTagEventAction,
  source: ContactTagSource,
): Promise<void> {
  try {
    await db.insert(contactTagEvents).values({
      id: randomUUID(),
      userId: owner,
      tag: tag.trim().toLowerCase(),
      email,
      action,
      source,
    })
  } catch (error) {
    console.error('[contact-tags] could not record a change:', error)
  }
}

/**
 * Every tag the user has, with how widely each is used.
 *
 * Grouped case-insensitively: "Acme" and "acme" are one row in a management
 * screen even if two contacts typed them differently, and the earliest spelling
 * is the one shown. A tag used once and a tag used fifty times are the same
 * thing to edit; the count is there to show what a rename or delete affects.
 */
export async function listContactTagSummary(
  userId: string,
): Promise<ContactTagSummary[]> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return []

  const [rows, definitions, events] = await Promise.all([
    db
      .select({ tag: contactTags.tag, source: contactTags.source })
      .from(contactTags)
      .where(eq(contactTags.userId, owner))
      .orderBy(asc(contactTags.createdAt)),
    // One read for the whole list rather than a join per row: a description
    // belongs to a word, and there are far fewer words than contacts.
    readTagDefinitions(owner),
    // One read for the whole page: three changes per tag is a line of history,
    // and the cap keeps a long-lived vocabulary from loading years of it.
    db
      .select({
        tag: contactTagEvents.tag,
        email: contactTagEvents.email,
        action: contactTagEvents.action,
        source: contactTagEvents.source,
        createdAt: contactTagEvents.createdAt,
      })
      .from(contactTagEvents)
      .where(eq(contactTagEvents.userId, owner))
      .orderBy(desc(contactTagEvents.createdAt))
      .limit(300),
  ])

  const changes = new Map<string, ContactTagChange[]>()
  for (const event of events) {
    const list = changes.get(event.tag) ?? []
    if (list.length >= 3) continue
    list.push({
      email: event.email,
      action: event.action,
      source: event.source,
      at: event.createdAt.getTime(),
    })
    changes.set(event.tag, list)
  }

  const byKey = new Map<string, ContactTagSummary>()

  // The definitions come first: a tag the user created, or described, is part of
  // the vocabulary even when no contact carries it yet, and the count of zero is
  // the honest way to show that.
  for (const definition of definitions) {
    const key = definition.tag.trim().toLowerCase()
    const recent = changes.get(key) ?? []
    const description = definition.description.trim()
    byKey.set(key, {
      tag: definition.tag,
      description: description || null,
      // Provenance survives an empty description: text the user cleared is still
      // theirs, and must not be drafted again behind their back.
      descriptionSource: definition.source,
      contacts: 0,
      auto: 0,
      updatedAt: definition.updatedAt.getTime(),
      lastChangeAt: recent[0]?.at ?? null,
      recentChanges: recent,
    })
  }

  for (const row of rows) {
    const key = row.tag.trim().toLowerCase()
    const existing = byKey.get(key)
    if (existing) {
      existing.contacts += 1
      if (row.source === 'auto') existing.auto += 1
    } else {
      const recent = changes.get(key) ?? []
      byKey.set(key, {
        tag: row.tag,
        description: null,
        descriptionSource: null,
        contacts: 1,
        auto: row.source === 'auto' ? 1 : 0,
        updatedAt: null,
        lastChangeAt: recent[0]?.at ?? null,
        recentChanges: recent,
      })
    }
  }

  return [...byKey.values()].sort((a, b) =>
    a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' }),
  )
}

/**
 * The change log of one tag, newest first, for the page's history panel.
 *
 * The summary carries the newest three changes so a row can show that something
 * moved; this reads the rest on demand, when the user asks to see it. `null` or
 * an unusable tag reads as no history rather than as an error — the panel has
 * nothing to show either way.
 */
export async function listContactTagHistory(
  userId: string,
  tag: string,
  limit = 50,
): Promise<ContactTagChange[]> {
  const owner = userId.trim().toLowerCase()
  const normalised = normaliseContactTag(tag)
  if (!owner || !normalised) return []

  const rows = await db
    .select({
      email: contactTagEvents.email,
      action: contactTagEvents.action,
      source: contactTagEvents.source,
      createdAt: contactTagEvents.createdAt,
    })
    .from(contactTagEvents)
    .where(
      and(
        eq(contactTagEvents.userId, owner),
        sql`lower(${contactTagEvents.tag}) = ${normalised.toLowerCase()}`,
      ),
    )
    .orderBy(desc(contactTagEvents.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    email: row.email,
    action: row.action,
    source: row.source,
    at: row.createdAt.getTime(),
  }))
}

/**
 * Rename one tag everywhere it appears.
 *
 * A rename is adding the new spelling and removing the old one, per contact, so
 * it is done as a move rather than a table of definitions being rewritten. A
 * contact that already carried the new spelling keeps one row (the old one is
 * dropped first), and the source of each surviving row is preserved: renaming an
 * automatic tag does not make it the user's, and vice versa.
 *
 * `null` means the new spelling was not a usable tag.
 */
export async function renameContactTag(
  userId: string,
  from: string,
  to: string,
): Promise<ContactTagSummary[] | null> {
  const owner = userId.trim().toLowerCase()
  const previous = normaliseContactTag(from)
  const next = normaliseContactTag(to)
  if (!owner || !previous || !next) return null
  if (sameContactTag(previous, next)) return listContactTagSummary(owner)

  // Read before the move: only a rename that carries a description should
  // replace the target's, and the target's is what would otherwise be lost.
  const moved = await db
    .select({ description: contactTagDescriptions.description })
    .from(contactTagDescriptions)
    .where(
      and(
        eq(contactTagDescriptions.userId, owner),
        sql`lower(${contactTagDescriptions.tag}) = ${previous.toLowerCase()}`,
      ),
    )
    .limit(1)

  await db.transaction(async (tx) => {
    if (moved.length > 0) {
      // The description belongs to the word, so it moves with it.
      await tx
        .delete(contactTagDescriptions)
        .where(
          and(
            eq(contactTagDescriptions.userId, owner),
            sql`lower(${contactTagDescriptions.tag}) = ${next.toLowerCase()}`,
          ),
        )
      await tx
        .update(contactTagDescriptions)
        .set({ tag: next, updatedAt: new Date() })
        .where(
          and(
            eq(contactTagDescriptions.userId, owner),
            sql`lower(${contactTagDescriptions.tag}) = ${previous.toLowerCase()}`,
          ),
        )
    }

    // Drop the target spelling first: both rows share the (user, address, tag)
    // key, so moving into an existing tag would otherwise collide.
    await tx
      .delete(contactTags)
      .where(and(eq(contactTags.userId, owner), eq(contactTags.tag, next)))
    await tx
      .update(contactTags)
      .set({ tag: next })
      .where(and(eq(contactTags.userId, owner), eq(contactTags.tag, previous)))

    // The history belongs to the word, so it moves with it rather than staying
    // under a spelling nobody can look up any more.
    await tx
      .update(contactTagEvents)
      .set({ tag: next.toLowerCase() })
      .where(
        and(
          eq(contactTagEvents.userId, owner),
          sql`lower(${contactTagEvents.tag}) = ${previous.toLowerCase()}`,
        ),
      )
  })

  return listContactTagSummary(owner)
}

/** Remove one tag from every contact that has it. */
export async function deleteContactTag(
  userId: string,
  tag: string,
): Promise<ContactTagSummary[]> {
  const owner = userId.trim().toLowerCase()
  const normalised = normaliseContactTag(tag)
  if (!owner || !normalised) return listContactTagSummary(owner)

  // Read before deleting: the log records who lost the word, and the rows are
  // the only place that knows.
  const removed = await db
    .select({ email: contactTags.email, source: contactTags.source })
    .from(contactTags)
    .where(and(eq(contactTags.userId, owner), eq(contactTags.tag, normalised)))

  await db.transaction(async (tx) => {
    await tx
      .delete(contactTags)
      .where(
        and(eq(contactTags.userId, owner), eq(contactTags.tag, normalised)),
      )
    // The word is gone, so what it meant goes with it rather than waiting to
    // attach itself to a future tag that happens to share the spelling.
    await tx
      .delete(contactTagDescriptions)
      .where(
        and(
          eq(contactTagDescriptions.userId, owner),
          sql`lower(${contactTagDescriptions.tag}) = ${normalised.toLowerCase()}`,
        ),
      )
    await tx
      .delete(contactTagEvents)
      .where(
        and(
          eq(contactTagEvents.userId, owner),
          sql`lower(${contactTagEvents.tag}) = ${normalised.toLowerCase()}`,
        ),
      )
  })

  for (const row of removed) {
    await recordTagEvent(owner, normalised, row.email, 'removed', row.source)
  }

  return listContactTagSummary(owner)
}

/**
 * Say what a tag is for, or clear what was said.
 *
 * `null` means the input was not a usable tag or the description was too long;
 * an empty description clears the text but keeps the tag itself, because the tag
 * may be one the user added on its own. Returns the whole list, so the caller
 * renders what storage holds rather than the draft it sent.
 */
export async function setContactTagDescription(
  userId: string,
  tag: string,
  value: string,
): Promise<ContactTagSummary[] | null> {
  return writeTagDescription(userId, tag, value, 'user')
}

/**
 * Store a description the app drafted itself.
 *
 * Same rules as the hand-written one, except the provenance: `auto` text is the
 * app's to revise when the tag's membership changes, and the first save by hand
 * claims it through `setContactTagDescription`.
 */
export async function saveAutoContactTagDescription(
  userId: string,
  tag: string,
  value: string,
): Promise<ContactTagSummary[] | null> {
  return writeTagDescription(userId, tag, value, 'auto')
}

async function writeTagDescription(
  userId: string,
  tag: string,
  value: string,
  source: ContactTagSource,
): Promise<ContactTagSummary[] | null> {
  const owner = userId.trim().toLowerCase()
  const normalised = normaliseContactTag(tag)
  const description = normaliseContactTagDescription(value)
  if (!owner || !normalised || description === null) return null

  const key = normalised.toLowerCase()
  const definitions = await readTagDefinitions(owner)
  const existing = definitions.find(
    (row) => row.tag.trim().toLowerCase() === key,
  )

  if (existing) {
    await db
      .update(contactTagDescriptions)
      .set({ description, source, updatedAt: new Date() })
      .where(
        and(
          eq(contactTagDescriptions.userId, owner),
          eq(contactTagDescriptions.tag, existing.tag),
        ),
      )
  } else if (description.length > 0) {
    // Describing a tag that only ever existed on contacts defines it too, so the
    // sentence survives even if nobody carries the word for a while.
    await db
      .insert(contactTagDescriptions)
      .values({ userId: owner, tag: normalised, description, source })
      .onConflictDoNothing()
  }

  return listContactTagSummary(owner)
}

/**
 * Add a tag to the vocabulary before anyone carries it.
 *
 * Tags used to exist only as rows on contacts, which made the list impossible to
 * seed: wanting "investor" available meant first thinking of an investor. A
 * definition is that missing half — the word on its own, with the description
 * attached when there is one.
 *
 * `null` means the name was not a usable tag. A name already in the list is not
 * an error and writes nothing twice; the caller has the list and can say so.
 */
export async function createContactTag(
  userId: string,
  value: string,
): Promise<ContactTagSummary[] | null> {
  const owner = userId.trim().toLowerCase()
  const tag = normaliseContactTag(value)
  if (!owner || !tag) return null

  const definitions = await readTagDefinitions(owner)
  if (!definitions.some((row) => sameContactTag(row.tag, tag))) {
    await db
      .insert(contactTagDescriptions)
      // `auto`: the empty text is the app's placeholder rather than something the
      // user wrote, so it may be filled in once somebody carries the tag.
      .values({ userId: owner, tag, description: '', source: 'auto' })
      .onConflictDoNothing()
  }

  return listContactTagSummary(owner)
}
