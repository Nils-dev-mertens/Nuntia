/**
 * Encrypt, in place, the plaintext values in columns that use the deterministic
 * envelope.
 *
 * `encryptedMatchText` only works as long as *both* sides of a comparison are
 * ciphertext. New writes are, but rows written before this change hold plain
 * `alice@example.com`, and a lookup filtered by `email = 'v1d:…'` would not find
 * them. A contact would silently disappear from the directory; a tag row would
 * look deleted while still occupying its primary key. That is why this runs on
 * every startup rather than being left to an operator script:
 *
 * - it is idempotent — rows already carrying `v1d:` are skipped;
 * - it is small — these are key columns on address-book-sized tables, not the
 *   mail bodies that `scripts/encrypt-at-rest.ts` rewrites;
 * - a missed row is a visible data loss, while the cost is a few hundred
 *   comparisons at boot.
 *
 * Failures are not swallowed: without the key, the comparison-time encryption
 * would fail on the first query anyway, and a boot that says so is better than
 * an app that appears to have lost its address book.
 */

import type { Client } from '@libsql/client'

import { encryptMatch } from '#/lib/auth/crypto.ts'

/**
 * The deterministic columns, by table and column name.
 *
 * Only columns that are actually compared in SQL belong here. Prose lives in
 * `encryptedText` columns, which keep their plaintext rows readable through the
 * column type and are backfilled by `scripts/encrypt-at-rest.ts`.
 */
const MATCH_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  // The address book: keyed by address, searched by address.
  { table: 'contacts', column: 'email' },
  { table: 'contact_contexts', column: 'email' },
  { table: 'contact_tags', column: 'email' },
  // A company is keyed by the domain its people write from.
  { table: 'contact_organizations', column: 'domain' },
  // Per-sender preferences, keyed by the sender's address.
  { table: 'sender_profiles', column: 'sender_email' },
  { table: 'sender_signals', column: 'sender_email' },
  // Either an address or a conversation id; both are compared in the undo path.
  { table: 'context_revisions', column: 'target' },
]

/**
 * Rewrite every plaintext value in those columns.
 *
 * `rowid` is used rather than the key columns because the key may itself be the
 * value being rewritten: setting a primary-key column while selecting by it is
 * legal only if the row is found some other way.
 */
export async function backfillMatchColumns(client: Client): Promise<void> {
  let rewritten = 0

  for (const { table, column } of MATCH_COLUMNS) {
    const rows = await client.execute({
      sql:
        `SELECT rowid AS rid, ${column} AS value FROM ${table} ` +
        `WHERE ${column} IS NOT NULL AND ${column} <> '' ` +
        `AND ${column} NOT LIKE 'v1d:%'`,
      args: [],
    })

    for (const row of rows.rows) {
      const value = row.value
      if (typeof value !== 'string' || value === '') continue

      await client.execute({
        sql: `UPDATE ${table} SET ${column} = ? WHERE rowid = ?`,
        args: [encryptMatch(value), Number(row.rid)],
      })
      rewritten++
    }
  }

  if (rewritten > 0) {
    // A count, never a value: the log must not become a copy of the data.
    console.log(`[db] encrypted ${rewritten} lookup key(s) written in plain text`)
  }
}
