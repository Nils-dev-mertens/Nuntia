/**
 * Encrypt mail content that was stored before it was encrypted.
 *
 * `src/db/encrypted-column.ts` makes every new write encrypted and every read
 * transparent, including pre-encryption rows. That is what lets an existing
 * install upgrade without a migration — but it also means old rows keep sitting
 * in the database file as plain text until something happens to rewrite them.
 * A backfill rewrites the threads it fetches; mail that is not re-synced would
 * stay readable to anyone with a copy of the file.
 *
 * This script closes that gap. It finds rows whose content does not carry the
 * `v1:` envelope and rewrites them through the encrypted column types, which is
 * enough because the app reads them back identically.
 *
 *   bun run scripts/encrypt-at-rest.ts
 *
 * Safe to run more than once: rows already encrypted are skipped, and the
 * envelope is per-value (a fresh IV each time), so a second run over an already
 * encrypted row would only cost writes, which the selector avoids.
 *
 * Run it with the service stopped. It takes the same write lock as the app but
 * it is a bulk rewrite, and a concurrent sync would fight it for the database.
 *
 * Two kinds of column are encrypted and only one of them is handled here:
 *
 * - **Content** (`encryptedText`, the random-IV `v1:` envelope) — the tables
 *   below. Plaintext rows stay readable through the column type, so this can
 *   run whenever the operator chooses.
 * - **Lookup keys** (`encryptedMatchText`, the deterministic `v1d:` envelope) —
 *   an address or a tag that a query filters on. Those cannot wait: a plaintext
 *   row would simply not be found. They are rewritten on every startup by
 *   `src/db/backfill-match-columns.ts` instead of here, and are deliberately
 *   absent from this list (re-encrypting one of them here would break its
 *   lookups).
 */

import { client, initDatabase } from '../src/db/index.ts'
import { encryptField } from '../src/db/encrypted-column.ts'

/**
 * Every content column that is encrypted at rest, as it is named in SQL.
 *
 * The SQL names are used rather than the drizzle objects because the rewrite is
 * per row (`rowid`) and the value is passed through the same `encryptField` the
 * column type uses — so there is one implementation of "how a value is
 * encrypted", not a second one that could drift.
 */
const CONTENT_COLUMNS: ReadonlyArray<{ table: string; columns: string[] }> = [
  { table: 'conversations', columns: ['subject', 'topic', 'goal'] },
  {
    table: 'messages',
    columns: [
      'subject',
      'snippet',
      'raw_body_text',
      'raw_body_html',
      'body_text',
      'body_html',
      'signature_text',
      'greeting_text',
      'detected_greeting_text',
      'detected_signature_text',
      'stripped_quote',
    ],
  },
  { table: 'contacts', columns: ['name'] },
  {
    table: 'contact_contexts',
    columns: [
      'role_company',
      'relationship',
      'topics',
      'current_work',
      'summary',
    ],
  },
  { table: 'contact_tag_descriptions', columns: ['description'] },
  { table: 'contact_tag_events', columns: ['email'] },
  { table: 'contact_organizations', columns: ['focus', 'suggested_focus'] },
  { table: 'sender_profiles', columns: ['reply_greeting', 'reply_signature'] },
  { table: 'reply_styles', columns: ['name', 'greeting', 'signature'] },
  {
    table: 'accounts',
    columns: ['default_reply_greeting', 'default_reply_signature'],
  },
  { table: 'decisions', columns: ['topic', 'reasoning'] },
  { table: 'attachments', columns: ['filename'] },
  { table: 'context_revisions', columns: ['previous_value', 'next_value'] },
  { table: 'organization_labels', columns: ['name', 'description'] },
  { table: 'organization_rules', columns: ['value'] },
  { table: 'state_labels', columns: ['name', 'description'] },
  { table: 'feedback', columns: ['email', 'message', 'resolution_note'] },
  { table: 'users', columns: ['name'] },
  { table: 'form_answers', columns: ['value_text'] },
]

await initDatabase()

let total = 0

for (const { table, columns } of CONTENT_COLUMNS) {
  for (const column of columns) {
    // NULL, empty and already-encrypted values are all skipped: the first two
    // have nothing to protect, the last is done. `v1d:` is excluded so a
    // deterministic key can never be re-encrypted into the wrong scheme.
    const rows = await client.execute({
      sql:
        `SELECT rowid AS rid, ${column} AS value FROM ${table} ` +
        `WHERE ${column} IS NOT NULL AND ${column} <> '' ` +
        `AND ${column} NOT LIKE 'v1:%' AND ${column} NOT LIKE 'v1d:%'`,
      args: [],
    })

    let rewritten = 0
    for (const row of rows.rows) {
      const value = row.value
      if (typeof value !== 'string' || value === '') continue

      await client.execute({
        sql: `UPDATE ${table} SET ${column} = ? WHERE rowid = ?`,
        args: [encryptField(value), Number(row.rid)],
      })
      rewritten++
    }

    if (rewritten > 0) {
      console.log(`${table}.${column}: ${rewritten}`)
      total += rewritten
    }
  }
}

console.log(
  total === 0
    ? 'nothing to do: every stored value already carries the envelope'
    : `encrypted ${total} value(s)`,
)
