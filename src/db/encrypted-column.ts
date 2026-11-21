/**
 * Encrypted column types.
 *
 * Mail content — subjects, bodies, greetings, signatures, quoted history — is
 * the most sensitive data this app holds, and it used to sit in the database
 * file as plain text. Only OAuth tokens and API keys were encrypted. A copy of
 * `data/lumen.db`, a backup, or `data/logs/../` on a shared host was therefore a
 * readable mailbox.
 *
 * These are drizzle custom column types rather than encrypt/decrypt calls at
 * each call site. That is the whole point: a custom type is applied by drizzle
 * on *every* insert, update, select and relational query, so a new read path
 * cannot forget to decrypt and a new write path cannot forget to encrypt. The
 * SQL type stays `text`, so no migration is needed and existing rows keep
 * working.
 *
 * Storage format is the same versioned envelope the OAuth tokens use
 * (`v1:<iv>:<tag>:<ciphertext>`), under `TOKEN_ENCRYPTION_KEY`.
 *
 * Some personal values are also keys — a contact's address, a sender's address,
 * a revision target. Those are read back through `encryptedMatchText`, which
 * uses the deterministic envelope (`v1d:`) so `WHERE email = ?`, primary keys
 * and unique indexes keep matching. Everything else uses the random-IV `v1:`
 * envelope. The difference and its trade-off are documented in
 * `#/lib/auth/crypto.ts`.
 *
 * Backwards compatibility is deliberate and asymmetric:
 *
 * - A value that is not an envelope is returned unchanged. That is how rows
 *   written before this change stay readable, and how a value written by a SQL
 *   default rather than by the app round-trips.
 * - A value that *is* an envelope but cannot be decrypted (wrong key, damaged
 *   row) is also returned unchanged, with one warning. Returning a placeholder
 *   or null would silently look like "this mail had no body", which is worse
 *   than showing the ciphertext and saying so in the log.
 *
 * Every decrypt failure is logged once per process, without the value: the
 * content must not reach a log, which is the rule the rest of the logging
 * already follows.
 */

import { customType } from 'drizzle-orm/sqlite-core'

import {
  decrypt,
  decryptMatch,
  encrypt,
  encryptMatch,
  isMatchEnvelope,
} from '#/lib/auth/crypto.ts'

/** The envelope prefix written by `encrypt()` in `#/lib/auth/crypto.ts`. */
const ENVELOPE_PREFIX = 'v1:'

let warnedAboutDecrypt = false

/** True when a stored string looks like one of our envelopes. */
export function isEncryptedValue(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX) || isMatchEnvelope(value)
}

/**
 * Encrypt one value for storage.
 *
 * `null` and `undefined` pass through: drizzle skips the mapper for null
 * columns, but a defensive guard here keeps a future call path from throwing
 * inside a query builder.
 *
 * The empty string also passes through. It is not content, and one upsert in
 * `#/lib/conversation/repository.ts` leans on it: `coalesce(nullif(excluded.name,
 * ''), contacts.name)` keeps the name already learned when a sync carries none.
 * Encrypting `''` would make that comparison compare ciphertext to `''`, and an
 * address with no name would erase the name it had.
 */
export function encryptField(value: string): string {
  if (typeof value !== 'string' || value === '') return value
  return encrypt(value)
}

/**
 * Decrypt one stored value, tolerating pre-encryption rows.
 *
 * Never throws: a column type that throws turns a wrong key into "the inbox is
 * broken" instead of "the inbox shows its ciphertext and the log says why".
 */
export function decryptField(value: string): string {
  if (typeof value !== 'string' || !isEncryptedValue(value)) return value

  try {
    return isMatchEnvelope(value) ? decryptMatch(value) : decrypt(value)
  } catch {
    if (!warnedAboutDecrypt) {
      warnedAboutDecrypt = true
      console.warn(
        '[db] could not decrypt a stored field. Check TOKEN_ENCRYPTION_KEY; ' +
          'the affected values are being returned as stored.',
      )
    }
    return value
  }
}

/** A `text` column encrypted with AES-256-GCM on the way in and out. */
export const encryptedText = customType<{
  data: string
  driverData: string
}>({
  dataType() {
    return 'text'
  },
  toDriver(value) {
    return encryptField(value)
  },
  fromDriver(value) {
    return decryptField(value)
  },
})

/**
 * A `text` column encrypted deterministically, for values that are also keys.
 *
 * Same reads and writes as `encryptedText` — the difference is only visible in
 * the stored bytes being stable (or the SQL being equality). Use it for columns
 * that appear in a `where` clause, a primary key or a unique index; a random IV
 * there would make equal values unequal and every lookup would stop matching.
 *
 * Never use it for prose: deterministic ciphertext lets a reader see which rows
 * repeat a value.
 */
export const encryptedMatchText = customType<{
  data: string
  driverData: string
}>({
  dataType() {
    return 'text'
  },
  toDriver(value) {
    if (typeof value !== 'string' || value === '') return value
    return encryptMatch(value)
  },
  fromDriver(value) {
    return decryptField(value)
  },
})

