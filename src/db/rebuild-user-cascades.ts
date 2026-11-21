/**
 * Rebuild the tables whose foreign key to `users` cannot cascade as created.
 *
 * `accounts.user_id` was added to an existing table by `ALTER TABLE` in
 * migration 0013, and SQLite cannot attach a cascading foreign key that way:
 * the stored constraint is `NO ACTION` however `schema.ts` declares it, so
 * deleting a user with a connected mailbox failed outright.
 *
 * `app_settings.user_id` came in the same way in the same migration, but
 * migration 0031 rebuilt that table for other column changes and baked the
 * cascade into the new definition. It is still checked here: the point is that
 * every owner key is *verified* rather than assumed, and the check is one
 * pragma read when there is nothing to do.
 *
 * SQLite has no `ALTER TABLE ... ADD CONSTRAINT`, so each table is rebuilt in
 * the documented twelve-step way: create a copy with the wanted definition,
 * move the rows, drop the old table, rename the copy, recreate its indexes.
 *
 * Doing that inside the drizzle migration runner is not possible: it wraps every
 * migration in a transaction, and `PRAGMA foreign_keys` is ignored inside one.
 * With foreign keys on, `DROP TABLE accounts` is an implicit delete of every
 * row, which cascades into `conversations`, `messages`, `attachments`,
 * `decisions` and the per-sender tables — it would destroy the mail. So the
 * rebuild runs here, after migrations, outside any transaction, where the pragma
 * can be switched off and the drop is just a drop.
 *
 * The definition is *read from the live table* rather than copied from
 * `schema.ts`: columns, defaults and indexes are whatever the migrations have
 * produced, so a column added later cannot be silently dropped by a stale DDL
 * string here. The only thing this module changes is the one foreign key.
 *
 * It is idempotent: a database whose key already cascades is left untouched.
 */

import type { Client } from '@libsql/client'

/**
 * Tables whose owner key has to be known-cascading before `DELETE FROM users`
 * can be trusted.
 *
 * `app_settings` normally already is (migration 0031 rebuilt it), so it is a
 * no-op check on a healthy database. Listing it keeps the guarantee explicit
 * instead of relying on one migration having done the right thing years ago.
 */
const TABLES = ['accounts', 'app_settings'] as const

/**
 * Anything that can run a statement: the client outside the rebuild, the
 * transaction for the rebuild itself. `client.execute` does not hold an explicit
 * `BEGIN` across calls, which is why the transaction object is used.
 */
type Executor = { execute: Client['execute'] }

/** Quote an identifier for a statement built here, never from input. */
function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

type ColumnRow = {
  name: string
  type: string | null
  notnull: number
  dflt_value: string | null
  pk: number
}

type ForeignKeyRow = {
  id: number
  seq: number
  table: string
  from: string
  to: string
  on_update: string
  on_delete: string
}

async function columnsOf(db: Executor, table: string): Promise<ColumnRow[]> {
  const result = await db.execute(`PRAGMA table_info(${quote(table)})`)
  return result.rows as unknown as ColumnRow[]
}

/** Foreign keys grouped by their `id`, in `seq` order (composite keys span rows). */
async function foreignKeysOf(
  db: Executor,
  table: string,
): Promise<ForeignKeyRow[][]> {
  const result = await db.execute(
    `PRAGMA foreign_key_list(${quote(table)})`,
  )
  const rows = result.rows as unknown as ForeignKeyRow[]

  const grouped = new Map<number, ForeignKeyRow[]>()
  for (const row of rows) {
    const key = Number(row.id)
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }

  return [...grouped.values()].map((group) =>
    group.sort((a, b) => Number(a.seq) - Number(b.seq)),
  )
}

/** True when the stored constraint on `user_id` already deletes with the user. */
async function userKeyCascades(db: Executor, table: string): Promise<boolean> {
  const result = await db.execute(
    `PRAGMA foreign_key_list(${quote(table)})`,
  )

  return (result.rows as unknown as ForeignKeyRow[]).some(
    (row) =>
      String(row.from) === 'user_id' &&
      String(row.table).toLowerCase() === 'users' &&
      String(row.on_delete).toUpperCase() === 'CASCADE',
  )
}

/** The `CREATE INDEX` statements that belong to the table. */
async function indexesOf(
  db: Executor,
  table: string,
): Promise<Array<{ name: string; sql: string }>> {
  const result = await db.execute({
    sql:
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' " +
      'AND tbl_name = ? AND sql IS NOT NULL',
    args: [table],
  })

  return result.rows.map((row) => ({
    name: String(row.name),
    sql: String(row.sql),
  }))
}

function columnSql(column: ColumnRow): string {
  const parts = [quote(String(column.name))]
  if (column.type) parts.push(String(column.type))
  if (Number(column.pk) > 0) parts.push('PRIMARY KEY')
  if (Number(column.notnull) === 1) parts.push('NOT NULL')
  if (column.dflt_value !== null && column.dflt_value !== undefined) {
    // Parenthesised because `table_info` hands back the expression without its
    // outer parentheses: `unixepoch() * 1000` is not valid after DEFAULT, while
    // `(unixepoch() * 1000)` is. A literal like `'google'` is fine either way.
    parts.push(`DEFAULT (${column.dflt_value})`)
  }

  return parts.join(' ')
}

function foreignKeySql(fks: ForeignKeyRow[]): string {
  const [first] = fks
  const from = fks.map((row) => quote(String(row.from))).join(', ')
  const to = fks.map((row) => quote(String(row.to))).join(', ')
  // The one intended change: the owner key deletes with the user instead of
  // blocking the delete. Every other key is carried over exactly as it is.
  const cascade = fks.some((row) => String(row.from) === 'user_id')

  return (
    `FOREIGN KEY (${from}) REFERENCES ${quote(String(first.table))} (${to}) ` +
    `ON UPDATE ${first.on_update} ON DELETE ${cascade ? 'CASCADE' : first.on_delete}`
  )
}

/**
 * Rebuild one table. Returns true when it was rebuilt, false when it was already
 * correct (or when the connection cannot turn foreign keys off).
 */
async function rebuildTable(
  client: Client,
  table: string,
): Promise<boolean> {
  if (await userKeyCascades(client, table)) return false

  const rebuilt = `_${table}_rebuilt`

  const pragmaBefore = await client.execute('PRAGMA foreign_keys')
  const foreignKeysWereOn = Number(pragmaBefore.rows[0]?.foreign_keys) === 1

  await client.execute('PRAGMA foreign_keys = OFF')
  const pragmaOff = await client.execute('PRAGMA foreign_keys')

  if (Number(pragmaOff.rows[0]?.foreign_keys) === 1) {
    // Remote or otherwise controlled elsewhere: leave the schema alone and say
    // so, because the constraint stays NO ACTION there.
    console.warn(
      '[db] could not disable foreign_keys; skipping the table rebuild. ' +
        'The user deletion cascade will not reach mailboxes or settings on ' +
        'this database.',
    )
    return false
  }

  try {
    const columns = await columnsOf(client, table)
    const foreignKeys = await foreignKeysOf(client, table)
    const indexes = await indexesOf(client, table)
    const columnList = columns
      .map((column) => quote(String(column.name)))
      .join(', ')

    const create = `CREATE TABLE ${quote(rebuilt)} (\n  ${[
      ...columns.map(columnSql),
      ...foreignKeys.map(foreignKeySql),
    ].join(',\n  ')}\n)`

    const before = await client.execute(
      `SELECT count(*) AS n FROM ${quote(table)}`,
    )
    const expected = Number(before.rows[0]?.n ?? 0)

    const tx = await client.transaction('write')
    try {
      await tx.execute(create)
      await tx.execute(
        `INSERT INTO ${quote(rebuilt)} (${columnList}) ` +
          `SELECT ${columnList} FROM ${quote(table)}`,
      )

      const copied = await tx.execute(
        `SELECT count(*) AS n FROM ${quote(rebuilt)}`,
      )
      if (Number(copied.rows[0]?.n ?? -1) !== expected) {
        throw new Error(
          `Rebuilding ${table} copied ${copied.rows[0]?.n} of ${expected} row(s).`,
        )
      }

      await tx.execute(`DROP TABLE ${quote(table)}`)
      await tx.execute(`ALTER TABLE ${quote(rebuilt)} RENAME TO ${quote(table)}`)

      for (const index of indexes) {
        await tx.execute(index.sql)
      }

      // Verify what the rebuild produced before committing: the key cascades,
      // and every index name still exists (an index silently dropped here would
      // be a uniqueness and performance regression nobody would notice).
      if (!(await userKeyCascades(tx, table))) {
        throw new Error(`Rebuilt ${table} without a cascading owner key.`)
      }
      const rebuiltIndexes = new Set(
        (await indexesOf(tx, table)).map((index) => index.name),
      )
      const missing = indexes
        .filter((index) => !rebuiltIndexes.has(index.name))
        .map((index) => index.name)
      if (missing.length > 0) {
        throw new Error(
          `Rebuilt ${table} lost its index(es): ${missing.join(', ')}`,
        )
      }

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {
        // The transaction may already be finished; the original error is the
        // useful one.
      }
      throw error
    }
  } finally {
    if (foreignKeysWereOn) await client.execute('PRAGMA foreign_keys = ON')
  }

  console.log(
    `[db] rebuilt ${table}: its owner foreign key now deletes with the user`,
  )
  return true
}

/**
 * Rebuild every table in `TABLES` that still has a `NO ACTION` owner key.
 *
 * A remote libSQL connection ignores `PRAGMA foreign_keys`, and dropping a
 * table there would take its rows with it, so the rebuild is skipped there
 * rather than attempted blind. Local file databases — the only kind this app
 * creates — are where the pragma works.
 */
export async function rebuildUserCascades(client: Client): Promise<number> {
  let rebuilt = 0

  for (const table of TABLES) {
    if (await rebuildTable(client, table)) rebuilt++
  }

  return rebuilt
}
