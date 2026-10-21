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
}

const DEFAULTS: UserPreferences = { useGravatar: false }

export async function getPreferences(userId: string): Promise<UserPreferences> {
  const row = await db.query.appSettings.findFirst({
    where: eq(appSettings.userId, userId.toLowerCase()),
  })

  return row ? { useGravatar: row.useGravatar } : DEFAULTS
}

/**
 * Update the preferences on the user's row, creating it when it does not exist.
 *
 * The update is scoped to `user_id`, not the primary key: a row adopted from
 * before accounts existed still carries the old `id`, and updating *that* row is
 * the point.
 */
export async function savePreferences(
  userId: string,
  input: UserPreferences,
): Promise<void> {
  const owner = userId.toLowerCase()
  const now = new Date()

  const existing = await db.query.appSettings.findFirst({
    where: eq(appSettings.userId, owner),
  })

  if (existing) {
    await db
      .update(appSettings)
      .set({ useGravatar: input.useGravatar, updatedAt: now })
      .where(eq(appSettings.userId, owner))
    return
  }

  await db.insert(appSettings).values({
    id: owner,
    userId: owner,
    useGravatar: input.useGravatar,
    updatedAt: now,
  })
}
