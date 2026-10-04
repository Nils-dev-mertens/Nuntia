/**
 * When to sync.
 *
 * Split out from `service.ts` as a dependency-free module because this is the one
 * piece of the sync path worth testing on its own: it is a policy decision, and
 * the failure mode of getting it wrong is subtle — sync too often burns Gmail
 * quota, too rarely and the inbox quietly goes stale while looking fine.
 */

/**
 * Re-sync once the cursor is older than this.
 *
 * Longer than the UI's revalidation interval on purpose: a two-minute poll that
 * also synced every time would hammer the Gmail API for a cursor that has not
 * moved. The poll re-reads the database instead.
 */
export const DEFAULT_STALE_AFTER_MS = 90_000

/**
 * Whether the stored cursor is old enough to warrant another sync.
 *
 * A null timestamp means the account has never synced, which is stale by
 * definition — treating it as fresh would leave a new account with a permanently
 * empty inbox and no error to explain it.
 *
 * `now` is injectable so tests do not have to sleep.
 */
export function isCursorStale(
  lastSyncedAt: Date | null,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
  now: number = Date.now(),
): boolean {
  if (lastSyncedAt === null) return true

  const age = now - lastSyncedAt.getTime()

  // A negative age means the stored timestamp is in the future, which is clock
  // skew or a corrupted value. Reading that as "fresh" would suppress syncing
  // for an unknown stretch of time, so sync instead and let the new timestamp
  // correct it.
  return age < 0 || age >= staleAfterMs
}