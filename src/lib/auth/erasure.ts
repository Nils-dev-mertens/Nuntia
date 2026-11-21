/**
 * Erase one person and everything the app holds about them.
 *
 * The schema was already built so that every row belonging to a user hangs off
 * that user by a cascading foreign key — but nothing ever deleted a user, so
 * "ask for a copy, correction or deletion" (which the privacy page promises) was
 * an operator hand-writing SQL, with no way to know whether the cascade had
 * actually fired.
 *
 * This module is that procedure, and its important property is that it *proves*
 * the result rather than assuming it:
 *
 * - The table list is discovered from SQLite's foreign-key metadata, not
 *   hard-coded, so a table added later with `onDelete: 'cascade'` is covered
 *   without anyone remembering to update a list here.
 * - It refuses to run with `PRAGMA foreign_keys` off, because that is exactly
 *   when the cascade silently does nothing.
 * - It re-counts every table after the delete and throws if anything is left,
 *   rather than reporting success because no error was raised.
 *
 * What is deliberately kept: invitation and access-request rows that mention the
 * address. They are records of the beta's own decisions rather than the person's
 * data, and the privacy page says they are kept while the beta runs. They are
 * reported so the operator can see them.
 */

import { eq } from 'drizzle-orm'

import { client, db } from '#/db/index.ts'
import { accounts, users } from '#/db/schema.ts'

/** A foreign key from some table to `users` that deletes the child row. */
type CascadingTable = { table: string; column: string }

export type ErasurePlan = {
  userId: string
  user: { id: string; email: string; name: string | null } | null
  /** Rows that the user's own foreign keys will remove, biggest first. */
  tables: Array<CascadingTable & { rows: number }>
  /** Mail synced from the user's connected mailboxes. */
  mail: {
    accounts: number
    conversations: number
    messages: number
    attachments: number
    decisions: number
  }
  /** Records about the address that are not owned by the user. */
  retained: { invites: number; accessRequests: number }
}

export type ErasureReport = {
  userId: string
  deleted: {
    tables: number
    rows: number
    mail: ErasurePlan['mail']
  }
  retained: ErasurePlan['retained']
}

/** Database tables, excluding SQLite's own and drizzle's migration bookkeeping. */
async function userTables(): Promise<string[]> {
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_drizzle%' ESCAPE '\\'",
  )

  return result.rows.map((row) => String(row.name))
}

/**
 * Every table with a cascading foreign key to `users`.
 *
 * Read from SQLite rather than a list in this file: a list is a thing that goes
 * stale silently, and the failure it causes is "the data was not deleted", which
 * is the one failure this whole module exists to prevent.
 */
async function cascadingTables(): Promise<CascadingTable[]> {
  const found: CascadingTable[] = []

  for (const table of await userTables()) {
    const fks = await client.execute(`PRAGMA foreign_key_list("${table}")`)

    for (const row of fks.rows) {
      if (
        String(row.table).toLowerCase() === 'users' &&
        String(row.on_delete).toUpperCase() === 'CASCADE'
      ) {
        found.push({ table, column: String(row.from) })
      }
    }
  }

  return found
}

/** Quote an identifier for use in a statement built here, never from input. */
function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

async function countWhere(
  table: string,
  column: string,
  value: string,
): Promise<number> {
  const result = await client.execute({
    sql: `SELECT count(*) AS n FROM ${quote(table)} WHERE ${quote(column)} = ?`,
    args: [value],
  })

  return Number(result.rows[0]?.n ?? 0)
}

async function countIn(
  table: string,
  column: string,
  values: string[],
): Promise<number> {
  if (values.length === 0) return 0

  const result = await client.execute({
    sql:
      `SELECT count(*) AS n FROM ${quote(table)} ` +
      `WHERE ${quote(column)} IN (${values.map(() => '?').join(', ')})`,
    args: values,
  })

  return Number(result.rows[0]?.n ?? 0)
}

/** The user's connected mailboxes, which own the mail rows. */
async function accountIdsOf(userId: string): Promise<string[]> {
  const result = await client.execute({
    sql: 'SELECT id FROM accounts WHERE user_id = ?',
    args: [userId],
  })

  return result.rows.map((row) => String(row.id))
}

async function mailCounts(
  accountIds: string[],
): Promise<ErasurePlan['mail']> {
  return {
    accounts: accountIds.length,
    conversations: await countIn('conversations', 'account_id', accountIds),
    messages: await countIn(
      'messages',
      'conversation_id',
      await conversationIds(accountIds),
    ),
    attachments: await countIn(
      'attachments',
      'conversation_id',
      await conversationIds(accountIds),
    ),
    decisions: await countIn(
      'decisions',
      'conversation_id',
      await conversationIds(accountIds),
    ),
  }
}

async function conversationIds(accountIds: string[]): Promise<string[]> {
  if (accountIds.length === 0) return []

  const result = await client.execute({
    sql:
      'SELECT id FROM conversations ' +
      `WHERE account_id IN (${accountIds.map(() => '?').join(', ')})`,
    args: accountIds,
  })

  return result.rows.map((row) => String(row.id))
}

/** What erasing this address would remove. Reads only; safe to show a user. */
export async function planUserErasure(
  userIdInput: string,
): Promise<ErasurePlan> {
  const userId = userIdInput.trim().toLowerCase()
  if (!userId) throw new Error('An email address is required.')

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, email: true, name: true },
  })

  const tables = await cascadingTables()
  const counts = await Promise.all(
    tables.map(async (entry) => ({
      ...entry,
      rows: await countWhere(entry.table, entry.column, userId),
    })),
  )

  const accountIds = await accountIdsOf(userId)

  return {
    userId,
    user: user ?? null,
    tables: counts.sort((a, b) => b.rows - a.rows),
    mail: await mailCounts(accountIds),
    retained: {
      invites: await countWhere('invites', 'email', userId),
      accessRequests: await countWhere('access_requests', 'email', userId),
    },
  }
}

/**
 * Delete the user and verify every dependent row went with them.
 *
 * Throws when the database is not enforcing foreign keys, when the address is
 * not present, or when anything survives the cascade — the last one is the check
 * that makes this trustworthy.
 */
export async function eraseUser(userIdInput: string): Promise<ErasureReport> {
  const plan = await planUserErasure(userIdInput)
  if (!plan.user) {
    throw new Error(`No user "${plan.userId}" in this database.`)
  }

  // Without this, `DELETE FROM users` succeeds and leaves every child row
  // intact. The pragma is per connection, so it has to be checked here rather
  // than trusted from startup.
  const pragma = await client.execute('PRAGMA foreign_keys')
  if (Number(pragma.rows[0]?.foreign_keys) !== 1) {
    throw new Error(
      'foreign_keys is off for this connection; refusing to erase, because the ' +
        'cascade would silently not run.',
    )
  }

  const accountIds = await accountIdsOf(plan.userId)
  const threadIds = await conversationIds(accountIds)

  // Mailboxes first, then the user.
  //
  // The database now carries cascading owner keys on `accounts` and
  // `app_settings`: startup rebuilds the tables made by migration 0013
  // (`src/db/rebuild-user-cascades.ts`), so the constraints fire and the mail
  // below the mailbox goes with it. The explicit delete stays for the database
  // where that rebuild could not run — a remote connection, or a file opened
  // without starting the app — because there the stored keys are still NO ACTION
  // and deleting the user first fails with SQLITE_CONSTRAINT_FOREIGNKEY. Either
  // way the mailboxes are gone before the user row is.
  await db.delete(accounts).where(eq(accounts.userId, plan.userId))
  await db.delete(users).where(eq(users.id, plan.userId))

  // The cascade reaches mail through `accounts`, which is two hops away from
  // `users`, so it is checked explicitly rather than inferred from the account
  // rows being gone.
  const leftoverTables = await Promise.all(
    plan.tables.map(async (entry) => ({
      table: entry.table,
      rows: await countWhere(entry.table, entry.column, plan.userId),
    })),
  )
  const surviving = leftoverTables.filter((entry) => entry.rows > 0)
  const survivingMail = {
    conversations: await countIn('conversations', 'account_id', accountIds),
    messages: await countIn('messages', 'conversation_id', threadIds),
    attachments: await countIn('attachments', 'conversation_id', threadIds),
    decisions: await countIn('decisions', 'conversation_id', threadIds),
  }

  if (
    surviving.length > 0 ||
    Object.values(survivingMail).some((rows) => rows > 0)
  ) {
    throw new Error(
      'Erasure incomplete — rows survived the cascade: ' +
        JSON.stringify({ tables: surviving, mail: survivingMail }),
    )
  }

  // Count the user row itself as well as the tables that hung off it, and keep
  // the mailboxes under `mail` where the operator already sees them. A report
  // that says "0 rows" after deleting a person is worse than no report.
  const populated = plan.tables.filter((entry) => entry.rows > 0)

  return {
    userId: plan.userId,
    deleted: {
      tables: populated.length + 1,
      rows: populated.reduce((total, entry) => total + entry.rows, 1),
      mail: plan.mail,
    },
    retained: plan.retained,
  }
}
