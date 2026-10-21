/**
 * Account persistence.
 *
 * Thin by design: the only interesting decision is that refresh tokens are
 * written encrypted and read back decrypted at the boundary, so nothing above
 * this layer has to think about it.
 *
 * Everything here is scoped by the owning user: a mailbox belongs to the person
 * who connected it, and no query in this module can reach another person's row
 * unless it is handed their id. `assertOwnedAccount` is the guard for the entry
 * points that take an account id straight from the client.
 */

import { and, desc, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { accounts, syncCursors } from '#/db/schema.ts'
import type { Provider } from '#/lib/mailbox/types.ts'
import { decryptRefreshToken, encryptRefreshToken } from './google.ts'

export type StoredAccount = {
  id: string
  /** The person who connected it. Null only for pre-accounts rows. */
  userId: string | null
  email: string
  provider: Provider
  /** Decrypted. Only present when the caller needs to talk to the provider. */
  refreshToken: string | null
  createdAt: Date
}

export type UpsertAccountInput = {
  /** The person connecting this mailbox. */
  userId: string
  email: string
  provider: Provider
  /** Plaintext from the provider. Encrypted here before it touches disk. */
  refreshToken: string | null
  scopes?: string
}

/**
 * Insert or update an account for one user.
 *
 * `id` is the email address, which is stable and already unique. When Google
 * returns no refresh token (because the grant already exists) the stored one is
 * left alone — overwriting with null would sign the user out on next sync.
 *
 * A mailbox already owned by somebody else is refused rather than reassigned.
 * Two people who both add `alex@example.com` cannot be told apart by the
 * provider, so the row has to keep the owner it was created with; handing it to
 * whoever signed in last would move a mailbox, and its whole synced history,
 * between accounts.
 */
export async function upsertAccount(input: UpsertAccountInput): Promise<void> {
  const id = input.email.toLowerCase()
  const userId = input.userId.toLowerCase()
  const encrypted = encryptRefreshToken(input.refreshToken)

  const existing = await db.query.accounts.findFirst({
    where: eq(accounts.id, id),
  })

  if (existing) {
    // A null owner is a pre-accounts row; the bootstrap/first-signup adoption
    // claims it, and until then whoever connects it first owns it.
    if (existing.userId && existing.userId !== userId) {
      throw new Error(
        `${input.email} is already connected to another account on this install.`,
      )
    }

    await db
      .update(accounts)
      .set({
        userId,
        provider: input.provider,
        refreshTokenEncrypted: encrypted ?? existing.refreshTokenEncrypted,
        scopes: input.scopes ?? existing.scopes,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, id))
    return
  }

  if (!encrypted) {
    // First-time sign-in with no refresh token is unusable — there would be no
    // way to refresh the access token later.
    throw new Error(
      `${PROVIDER_LABEL[input.provider]} did not return a refresh token. Revoke the app grant in your account and try again.`,
    )
  }

  await db.insert(accounts).values({
    id,
    userId,
    email: input.email.toLowerCase(),
    provider: input.provider,
    refreshTokenEncrypted: encrypted,
    scopes: input.scopes,
  })
}

/** How a provider is named in a message the user reads. */
const PROVIDER_LABEL: Record<Provider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
}

/** Fetch a decrypted account, or null when not connected. */
export async function getAccount(id: string): Promise<StoredAccount | null> {
  const row = await db.query.accounts.findFirst({
    where: eq(accounts.id, id.toLowerCase()),
  })

  if (!row) return null

  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    provider: row.provider,
    refreshToken: decryptRefreshToken(row.refreshTokenEncrypted),
    createdAt: row.createdAt,
  }
}

/**
 * True when this user owns this mailbox.
 *
 * The pair to check on any path where the account id came in with a request —
 * a server function argument, a URL — rather than out of a query already scoped
 * to the signed-in user.
 */
export async function ownsAccount(
  userId: string,
  accountId: string,
): Promise<boolean> {
  const row = await db.query.accounts.findFirst({
    where: and(
      eq(accounts.id, accountId.toLowerCase()),
      eq(accounts.userId, userId.toLowerCase()),
    ),
  })

  return Boolean(row)
}

/**
 * Refuse unless the mailbox belongs to this user.
 *
 * A thrown error rather than a boolean because every caller that needs it is
 * already in a place where acting on somebody else's mailbox would be the bug;
 * reporting "not found" also keeps the check from confirming that the mailbox
 * exists on this install.
 */
export async function assertOwnedAccount(
  userId: string,
  accountId: string,
): Promise<void> {
  if (!(await ownsAccount(userId, accountId))) {
    throw new Error('That mailbox is not connected to this account.')
  }
}

/** The stored ciphertext, for building a Gmail client without exposing the
 *  plaintext any further than necessary. */
export async function getAccountEnvelope(id: string): Promise<string | null> {
  const row = await db.query.accounts.findFirst({
    where: eq(accounts.id, id.toLowerCase()),
  })

  return row?.refreshTokenEncrypted ?? null
}

/**
 * Replace the stored refresh token ciphertext.
 *
 * Microsoft rotates refresh tokens; Google sometimes only returns one on the
 * first consent. Both end up here, and neither ever sees the plaintext written
 * to disk.
 */
export async function saveRefreshTokenEnvelope(
  id: string,
  envelope: string,
): Promise<void> {
  await db
    .update(accounts)
    .set({ refreshTokenEncrypted: envelope, updatedAt: new Date() })
    .where(eq(accounts.id, id.toLowerCase()))
}

/**
 * List one user's connected accounts, without decrypted tokens.
 *
 * Ordered by connection time, which is what the UI shows and what the merge
 * uses as a stable tiebreak between two mailboxes holding the same thread.
 */
export async function listAccounts(
  userId: string,
): Promise<
  Array<{ id: string; email: string; provider: Provider; createdAt: Date }>
> {
  const rows = await db.query.accounts.findMany({
    where: eq(accounts.userId, userId.toLowerCase()),
    orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
  })

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    provider: r.provider,
    createdAt: r.createdAt,
  }))
}

/** Which cursor a provider's incremental sync uses. */
export type CursorKind = 'history' | 'received'

/**
 * Persist where an account's incremental sync left off.
 *
 * One row per `(account, kind)`: the value is opaque to this layer and means
 * whatever the provider's adapter says it means. `updatedAt` is the sync clock —
 * `accounts.updatedAt` cannot serve, because it is also bumped whenever the
 * OAuth token is refreshed.
 */
export async function setCursor(
  id: string,
  kind: CursorKind,
  value: string,
): Promise<void> {
  const accountId = id.toLowerCase()
  const now = new Date()

  await db
    .insert(syncCursors)
    .values({ accountId, kind, value, updatedAt: now })
    .onConflictDoUpdate({
      target: [syncCursors.accountId, syncCursors.kind],
      set: { value, updatedAt: now },
    })
}

/**
 * When this account last completed a sync, or null if it never has.
 *
 * Null means "never synced", which the caller must treat as stale — otherwise a
 * fresh account would never sync.
 */
export async function getLastSyncedAt(id: string): Promise<Date | null> {
  const row = await db.query.syncCursors.findFirst({
    where: eq(syncCursors.accountId, id.toLowerCase()),
    orderBy: desc(syncCursors.updatedAt),
  })

  return row?.updatedAt ?? null
}

/**
 * The stored cursor value only, for one kind of sync.
 *
 * `getAccount` decrypts the refresh token, which is wasted work for a caller
 * that only needs to know where sync left off.
 */
export async function getCursor(
  id: string,
  kind: CursorKind,
): Promise<string | null> {
  const row = await db.query.syncCursors.findFirst({
    where: and(
      eq(syncCursors.accountId, id.toLowerCase()),
      eq(syncCursors.kind, kind),
    ),
  })

  return row?.value ?? null
}

/**
 * Which revision of the derived conversation fields has been backfilled.
 *
 * Incremental sync only rewrites threads Gmail reports as changed, so a derived
 * column added to `conversations` later would otherwise keep its migration
 * default for every already-synced conversation, silently. Comparing this
 * against `DERIVED_VERSION` is what triggers the one-off recomputation.
 */
export async function getDerivedVersion(id: string): Promise<number> {
  const row = await db.query.accounts.findFirst({
    where: eq(accounts.id, id.toLowerCase()),
  })

  return row?.derivedVersion ?? 0
}

/** Record that derived fields are now at `version`. */
export async function setDerivedVersion(
  id: string,
  version: number,
): Promise<void> {
  await db
    .update(accounts)
    .set({ derivedVersion: version })
    .where(eq(accounts.id, id.toLowerCase()))
}

/**
 * Record when a mailbox's push registration lapses.
 *
 * Null clears it, which is what a rejected `watch` leaves behind: the next load
 * then tries to register again rather than trusting a date in the past.
 */
export async function setPushExpiresAt(
  id: string,
  expiresAt: Date | null,
): Promise<void> {
  await db
    .update(accounts)
    .set({ pushExpiresAt: expiresAt })
    .where(eq(accounts.id, id.toLowerCase()))
}

/** When this mailbox's push registration lapses, or null if never registered. */
export async function getPushExpiresAt(id: string): Promise<Date | null> {
  const row = await db.query.accounts.findFirst({
    where: eq(accounts.id, id.toLowerCase()),
  })

  return row?.pushExpiresAt ?? null
}

/**
 * The mailbox a provider's notification names.
 *
 * A push payload carries only the address it is about, so this is the lookup
 * that turns a notification into an account — and, through `userId`, into whose
 * mail may be synced. An address nobody here has connected matches nothing, so a
 * notification for a mailbox this install does not hold is ignored.
 */
export async function findAccountByEmail(email: string): Promise<{
  id: string
  userId: string | null
  provider: Provider
  email: string
} | null> {
  const row = await db.query.accounts.findFirst({
    where: eq(accounts.email, email.trim().toLowerCase()),
  })

  if (!row) return null
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    email: row.email,
  }
}

/** Disconnect an account and delete everything synced from it. */
export async function deleteAccount(userId: string, id: string): Promise<void> {
  await db
    .delete(accounts)
    .where(
      and(
        eq(accounts.id, id.toLowerCase()),
        eq(accounts.userId, userId.toLowerCase()),
      ),
    )
}
