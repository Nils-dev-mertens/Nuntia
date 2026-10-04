/**
 * Account persistence.
 *
 * Thin by design: the only interesting decision is that refresh tokens are
 * written encrypted and read back decrypted at the boundary, so nothing above
 * this layer has to think about it.
 */

import { eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { accounts, historyCursors } from '#/db/schema.ts'
import { decryptRefreshToken, encryptRefreshToken } from './google.ts'

export type StoredAccount = {
  id: string
  email: string
  /** Decrypted. Only present when the caller needs to talk to Google. */
  refreshToken: string | null
  historyId: string | null
  createdAt: Date
}

export type UpsertAccountInput = {
  email: string
  /** Plaintext from Google. Encrypted here before it touches disk. */
  refreshToken: string | null
  scopes?: string
  historyId?: string | null
}

/**
 * Insert or update an account.
 *
 * `id` is the email address, which is stable and already unique. When Google
 * returns no refresh token (because the grant already exists) the stored one is
 * left alone — overwriting with null would sign the user out on next sync.
 */
export async function upsertAccount(
  input: UpsertAccountInput,
): Promise<void> {
  const id = input.email.toLowerCase()
  const encrypted = encryptRefreshToken(input.refreshToken)

  const existing = await db.query.accounts.findFirst({
    where: eq(accounts.id, id),
  })

  if (existing) {
    await db
      .update(accounts)
      .set({
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
      'Google did not return a refresh token. Revoke the app grant in your Google account and try again.',
    )
  }

  await db.insert(accounts).values({
    id,
    email: input.email.toLowerCase(),
    refreshTokenEncrypted: encrypted,
    scopes: input.scopes,
    historyId: input.historyId ?? null,
  })
}

/** Fetch a decrypted account, or null when not connected. */
export async function getAccount(id: string): Promise<StoredAccount | null> {
  const row = await db.query.accounts.findFirst({
    where: eq(accounts.id, id.toLowerCase()),
  })

  if (!row) return null

  return {
    id: row.id,
    email: row.email,
    refreshToken: decryptRefreshToken(row.refreshTokenEncrypted),
    historyId: row.historyId,
    createdAt: row.createdAt,
  }
}

/** The stored ciphertext, for building a Gmail client without exposing the
 *  plaintext any further than necessary. */
export async function getAccountEnvelope(
  id: string,
): Promise<string | null> {
  const row = await db.query.accounts.findFirst({
    where: eq(accounts.id, id.toLowerCase()),
  })

  return row?.refreshTokenEncrypted ?? null
}

/** List connected accounts, without decrypted tokens. */
export async function listAccounts(): Promise<
  Array<{ id: string; email: string; createdAt: Date }>
> {
  const rows = await db.query.accounts.findMany()

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    createdAt: r.createdAt,
  }))
}

/**
 * Persist the Gmail history cursor so sync can resume incrementally.
 *
 * The cursor id lands on the account row and the timestamp in `history_cursors`,
 * and the split is deliberate: `accounts.updatedAt` is also bumped whenever the
 * OAuth token is refreshed, so it cannot answer "when did we last sync?". The
 * staleness check needs an answer to exactly that question.
 */
export async function setHistoryId(id: string, historyId: string): Promise<void> {
  const accountId = id.toLowerCase()
  const now = new Date()

  await db
    .update(accounts)
    .set({ historyId, updatedAt: now })
    .where(eq(accounts.id, accountId))

  await db
    .insert(historyCursors)
    .values({ accountId, historyId, updatedAt: now })
    .onConflictDoUpdate({
      target: historyCursors.accountId,
      set: { historyId, updatedAt: now },
    })
}

/**
 * When this account last completed a sync, or null if it never has.
 *
 * Null means "never synced", which the caller must treat as stale — otherwise a
 * fresh account would never sync.
 */
export async function getLastSyncedAt(id: string): Promise<Date | null> {
  const row = await db.query.historyCursors.findFirst({
    where: eq(historyCursors.accountId, id.toLowerCase()),
  })

  return row?.updatedAt ?? null
}

/**
 * The stored cursor id only.
 *
 * `getAccount` decrypts the refresh token, which is wasted work for a caller
 * that only needs to know where sync left off.
 */
export async function getHistoryId(id: string): Promise<string | null> {
  const row = await db.query.accounts.findFirst({
    where: eq(accounts.id, id.toLowerCase()),
  })

  return row?.historyId ?? null
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
export async function setDerivedVersion(id: string, version: number): Promise<void> {
  await db
    .update(accounts)
    .set({ derivedVersion: version })
    .where(eq(accounts.id, id.toLowerCase()))
}

/** Disconnect an account and delete everything synced from it. */
export async function deleteAccount(id: string): Promise<void> {
  await db.delete(accounts).where(eq(accounts.id, id.toLowerCase()))
}