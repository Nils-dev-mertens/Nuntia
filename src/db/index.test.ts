import { afterAll, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-db-migration-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { client, db, initDatabase } = await import('./index.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')
const oldMigrationsFolder = join(tmpDir, 'drizzle-v15')
cpSync('./drizzle', oldMigrationsFolder, { recursive: true })
const journalPath = join(oldMigrationsFolder, 'meta', '_journal.json')
const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
  entries: unknown[]
}
journal.entries.pop()
writeFileSync(journalPath, JSON.stringify(journal))

await migrate(db, { migrationsFolder: oldMigrationsFolder })

afterAll(() => {
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

/**
 * Nothing deletes `tmpDir` when these tests finish, on purpose.
 *
 * `#/db/index.ts` binds a single client for the whole process, and every later
 * test file shares it — reassigning `DATABASE_URL` there is too late, the module
 * is already loaded. This file imports it first, so its temp file is the
 * database the rest of the suite runs on. Removing the directory here left the
 * remaining files querying a database that no longer existed: invisible on
 * Windows, where an open SQLite file cannot be unlinked, and
 * `ConnectionFailed(... 14)` for 84 tests on the Linux runner.
 *
 * The connection is still open when the run ends, so there is no safe moment to
 * remove it: the directory is left to the OS temp cleaner.
 */

test('startup applies pending migrations before message body queries', async () => {
  await initDatabase()

  const columns = await client.execute('PRAGMA table_info(messages)')
  const columnNames = columns.rows.map((row) => row.name)
  expect(columnNames).toContain('raw_body_text')
  expect(columnNames).toContain('raw_body_html')

  // Exercise the exact projection from the reparse query that previously failed.
  await client.execute(
    `SELECT id, "from", raw_body_text, raw_body_html, body_text, body_html,
      greeting_text, signature_text, stripped_quote FROM messages LIMIT 1`,
  )
})
