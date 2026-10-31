/**
 * Non-AI preferences, stored on the same per-user `app_settings` row.
 *
 * Kept apart from `ai/settings.ts` so the AI module stays about keys and models.
 * Both write the same row, so each one only ever touches its own columns — a
 * preference save must never clear a stored key, and a key save must never reset
 * a preference.
 */

import { eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { appSettings } from '#/db/schema.ts'

export type UserPreferences = {
  /**
   * Whether avatars may be fetched from Gravatar.
   *
   * Off unless the user turns it on: the URL carries an MD5 of the address, and
   * a local-first client should not tell a third party who writes to them.
   */
  useGravatar: boolean
  /**
   * The user's inbox section order, as tokens; empty means "the default".
   *
   * Kept opaque here — `organization/inbox-order.ts` owns what a token means and
   * which ones are current, so this module never has to know about labels.
   */
  inboxOrder: string[]
}

const DEFAULTS: UserPreferences = { useGravatar: false, inboxOrder: [] }

export async function getPreferences(userId: string): Promise<UserPreferences> {
  const row = await db.query.appSettings.findFirst({
    where: eq(appSettings.userId, userId.toLowerCase()),
  })

  return row
    ? { useGravatar: row.useGravatar, inboxOrder: row.inboxOrder ?? [] }
    : DEFAULTS
}

/**
 * Update the preferences on the user's row, creating it when it does not exist.
 *
 * Partial on purpose: the inbox saves an order, Settings saves the avatar
 * choice, and each must leave the other's column alone. A caller that passes
 * neither writes nothing but the timestamp.
 *
 * The update is scoped to `user_id`, not the primary key: a row adopted from
 * before accounts existed still carries the old `id`, and updating *that* row is
 * the point.
 */
export async function savePreferences(
  userId: string,
  input: Partial<UserPreferences>,
): Promise<void> {
  const owner = userId.toLowerCase()
  const now = new Date()

  const patch = {
    ...(input.useGravatar === undefined
      ? {}
      : { useGravatar: input.useGravatar }),
    ...(input.inboxOrder === undefined ? {} : { inboxOrder: input.inboxOrder }),
    updatedAt: now,
  }

  const existing = await db.query.appSettings.findFirst({
    where: eq(appSettings.userId, owner),
  })

  if (existing) {
    await db.update(appSettings).set(patch).where(eq(appSettings.userId, owner))
    return
  }

  await db.insert(appSettings).values({
    id: owner,
    userId: owner,
    useGravatar: input.useGravatar ?? DEFAULTS.useGravatar,
    inboxOrder: input.inboxOrder ?? null,
    updatedAt: now,
  })
}
