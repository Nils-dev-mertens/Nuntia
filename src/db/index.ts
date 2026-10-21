import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'

import * as schema from './schema.ts'

const url = process.env.DATABASE_URL ?? 'file:./data/lumen.db'

/**
 * Refuse to bind a test run to the real mailbox database.
 *
 * Sync tests delete every message and conversation before each case. If those
 * statements ever run against `data/lumen.db` they wipe a real synced account —
 * which happened, and is not recoverable from the app: the encrypted refresh
 * token goes with it and the user has to re-authenticate with Google.
 *
 * The test preload points `DATABASE_URL` at a temp file, so this only fires if
 * that isolation is bypassed or broken. It is deliberately fatal: a loud crash
 * is much cheaper than a destroyed mailbox.
 */
if (process.env.LUMEN_TEST === '1' && url.includes('data/lumen.db')) {
  throw new Error(
    'Refusing to run tests against the real database. ' +
      `Resolved DATABASE_URL is "${url}". ` +
      'test/setup.ts should redirect this to a temp file; check that bunfig.toml ' +
      'still preloads it.',
  )
}

/**
 * libSQL is used rather than better-sqlite3 because better-sqlite3 requires a
 * native node-gyp build (fails on this Windows box without the VS C++ workload).
 * libSQL speaks the same SQLite dialect over a local file:// URL with prebuilt
 * binaries, so the schema and queries are unchanged.
 */
const client = createClient({
  url,
  authToken: url.startsWith('file:')
    ? undefined
    : process.env.DATABASE_AUTH_TOKEN,
})

export const db = drizzle(client, { schema })
export { client }

/**
 * Prepare SQLite for concurrent access.
 *
 * Sync writes several threads in parallel, and SQLite's default rollback journal
 * takes an exclusive lock for every write — concurrent writers get SQLITE_BUSY
 * and drop mail. WAL lets readers and a writer proceed together, and the busy
 * timeout makes a contended writer wait rather than fail immediately.
 *
 * Only for local files: a remote libSQL URL manages its own concurrency.
 *
 * Not called at import — it is async, and the app's own entry point (`server.ts`)
 * awaits it once before serving requests. It used to claim it ran at import
 * while nothing outside the tests called it, so a running app never applied any
 * of this.
 */
let databaseReady: Promise<void> | undefined

export function initDatabase(): Promise<void> {
  databaseReady ??= prepareDatabase()
  return databaseReady
}

async function prepareDatabase(): Promise<void> {
  if (url.startsWith('file:')) {
    try {
      // WAL is persistent, but setting it again is cheap and covers a fresh file.
      await client.execute('PRAGMA journal_mode = WAL')
      // Wait rather than throw when another writer holds the lock.
      await client.execute('PRAGMA busy_timeout = 5000')
      // Enforce foreign keys so cascading deletes actually fire.
      await client.execute('PRAGMA foreign_keys = ON')
      // Logged rather than assumed: nothing else in the app can report whether
      // these settings took effect, and their absence is silent until a sync drops
      // mail.
      console.log(
        '[db] SQLite prepared: WAL, busy_timeout=5000, foreign_keys=ON',
      )
    } catch (error) {
      // A read-only database or an already-locked file should not crash startup;
      // the first real query will surface the problem with better context.
      console.warn('[db] could not apply SQLite pragmas:', error)
    }
  }

  // Existing installs may have a database from before the current schema. Apply
  // migrations before serving a request so queries never race ahead of columns
  // such as messages.raw_body_text. Do not swallow migration errors: serving with
  // a partially upgraded schema would turn a recoverable startup failure into
  // broken inbox requests.
  await migrate(db, { migrationsFolder: './drizzle' })
  console.log('[db] migrations applied')
}
