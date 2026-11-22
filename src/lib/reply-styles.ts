/**
 * Named greeting and signature pairs, assignable per sender.
 *
 * The account default stays what it was — one pair for everyone — and a sender
 * may instead name one of these. Keeping the variants in rows rather than a
 * `formal`/`informal` column means the user can have as many as their
 * relationships need, call them what they like, and change the wording in one
 * place instead of editing every sender.
 */

import { randomUUID } from 'node:crypto'

import { and, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { replyStyles, senderProfiles } from '#/db/schema.ts'
import { withWriteLock } from '#/lib/db/write-lock.ts'
import { REPLY_STYLE_LIMITS } from '#/lib/reply-style-limits.ts'

export type ReplyStyleProfile = {
  id: string
  name: string
  greeting: string | null
  signature: string | null
  /** Used for senders that have no style of their own. */
  isDefault: boolean
}

/** Raised for input the form should already have refused; shown verbatim. */
export class ReplyStyleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplyStyleError'
  }
}

function toProfile(row: typeof replyStyles.$inferSelect): ReplyStyleProfile {
  return {
    id: row.id,
    name: row.name,
    greeting: row.greeting,
    signature: row.signature,
    isDefault: row.isDefault,
  }
}

/** True when the person already has a fallback style. */
async function hasDefaultStyle(userId: string): Promise<boolean> {
  const row = await db
    .select({ id: replyStyles.id })
    .from(replyStyles)
    .where(and(eq(replyStyles.userId, userId), eq(replyStyles.isDefault, true)))
    .limit(1)

  return row.length > 0
}

/** Every style the person owns, by name. */
export async function listReplyStyles(
  userId: string,
): Promise<ReplyStyleProfile[]> {
  const rows = await db
    .select()
    .from(replyStyles)
    .where(eq(replyStyles.userId, userId))

  // Sorted here rather than in SQL: the name is encrypted, so ordering the
  // ciphertext would order nonsense. The default comes first so it is the one
  // people see when they open the list.
  return rows
    .map(toProfile)
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        a.name.localeCompare(b.name),
    )
}

/** The same list keyed by id, for resolving a sender's assignment. */
export async function replyStylesForUser(
  userId: string,
): Promise<Map<string, ReplyStyleProfile>> {
  return new Map(
    (await listReplyStyles(userId)).map((style) => [style.id, style]),
  )
}

/** One style, scoped to its owner; null for a missing or foreign id. */
export async function getReplyStyle(
  userId: string,
  id: string,
): Promise<ReplyStyleProfile | null> {
  const row = await db.query.replyStyles.findFirst({
    where: and(eq(replyStyles.id, id), eq(replyStyles.userId, userId)),
  })

  return row ? toProfile(row) : null
}

/**
 * Create or update one style.
 *
 * An id that is not this user's is treated as missing rather than overwritten,
 * because the id arrives from the browser.
 */
export async function saveReplyStyle(
  userId: string,
  input: {
    id?: string | null
    name: string
    greeting: string | null
    signature: string | null
  },
): Promise<ReplyStyleProfile> {
  const name = input.name.trim()
  if (!name) throw new ReplyStyleError('Give the reply style a name.')
  if (name.length > REPLY_STYLE_LIMITS.name) {
    throw new ReplyStyleError(
      `Keep the reply style name to ${REPLY_STYLE_LIMITS.name} characters or fewer.`,
    )
  }

  const greeting = input.greeting?.trim() || null
  if (greeting && greeting.length > REPLY_STYLE_LIMITS.greeting) {
    throw new ReplyStyleError(
      `Keep the greeting to ${REPLY_STYLE_LIMITS.greeting} characters or fewer.`,
    )
  }
  const signature = input.signature?.trim() || null
  if (signature && signature.length > REPLY_STYLE_LIMITS.signature) {
    throw new ReplyStyleError(
      `Keep the signature to ${REPLY_STYLE_LIMITS.signature} characters or fewer.`,
    )
  }

  const existing = input.id ? await getReplyStyle(userId, input.id) : null
  if (input.id && !existing) {
    throw new ReplyStyleError('That reply style no longer exists.')
  }

  let isDefault = existing?.isDefault ?? false
  const profile = {
    id: existing?.id ?? randomUUID(),
    name,
    greeting,
    signature,
  }

  await withWriteLock(async () => {
    if (existing) {
      await db
        .update(replyStyles)
        .set({ ...profile, updatedAt: new Date() })
        .where(
          and(eq(replyStyles.id, profile.id), eq(replyStyles.userId, userId)),
        )
      return
    }

    // The first style becomes the default, so creating one is enough to have
    // a fallback; later styles need an explicit "Make default".
    isDefault = !(await hasDefaultStyle(userId))
    await db
      .insert(replyStyles)
      .values({ ...profile, userId, isDefault, updatedAt: new Date() })
  })

  return { ...profile, isDefault }
}

/**
 * Make one style the fallback for unassigned senders.
 *
 * At most one per person: the previous default is cleared in the same
 * transaction. Returns the full list because every row's badge changes.
 */
export async function setDefaultReplyStyle(
  userId: string,
  id: string,
): Promise<ReplyStyleProfile[]> {
  await withWriteLock(async () => {
    await db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: replyStyles.id })
        .from(replyStyles)
        .where(and(eq(replyStyles.id, id), eq(replyStyles.userId, userId)))
        .limit(1)

      if (owned.length === 0) {
        throw new ReplyStyleError('That reply style no longer exists.')
      }

      await tx
        .update(replyStyles)
        .set({ isDefault: false })
        .where(eq(replyStyles.userId, userId))
      await tx
        .update(replyStyles)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(and(eq(replyStyles.id, id), eq(replyStyles.userId, userId)))
    })
  })

  return listReplyStyles(userId)
}

/**
 * Delete one style and clear every sender that had it assigned.
 *
 * The clearing is explicit even though the column declares `ON DELETE SET
 * NULL`: it keeps the stored assignment honest regardless of how the database
 * was migrated, and updates `updated_at` in the same pass. When the deleted
 * style was the default, the alphabetically first remaining style takes over so
 * there is still a fallback.
 */
export async function deleteReplyStyle(
  userId: string,
  id: string,
): Promise<ReplyStyleProfile[]> {
  await withWriteLock(async () => {
    await db.transaction(async (tx) => {
      const deleted = await tx
        .select({ isDefault: replyStyles.isDefault })
        .from(replyStyles)
        .where(and(eq(replyStyles.id, id), eq(replyStyles.userId, userId)))
        .limit(1)

      await tx
        .update(senderProfiles)
        .set({ replyStyleId: null, updatedAt: new Date() })
        .where(eq(senderProfiles.replyStyleId, id))
      await tx
        .delete(replyStyles)
        .where(and(eq(replyStyles.id, id), eq(replyStyles.userId, userId)))

      if (!deleted[0]?.isDefault) return

      // Keep a default whenever styles remain; without this, deleting the one
      // marked default would silently move everyone to the mailbox fallback.
      const remaining = await tx
        .select()
        .from(replyStyles)
        .where(eq(replyStyles.userId, userId))
      if (remaining.length === 0) return

      const next = remaining
        .map(toProfile)
        .sort((a, b) => a.name.localeCompare(b.name))[0]
      await tx
        .update(replyStyles)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(and(eq(replyStyles.id, next.id), eq(replyStyles.userId, userId)))
    })
  })

  return listReplyStyles(userId)
}
