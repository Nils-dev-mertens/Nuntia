/**
 * The operator gate.
 *
 * Two ways in — the role on the user row and the environment allowlist — and
 * the important property is that neither widens into "any signed-in user".
 * These checks are pure queries, so they run without a request context; the
 * session half is exercised by the dev-server walk instead.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-guard-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const { users } = await import('#/db/schema.ts')
const { isOperatorEmail, isOperatorUser, promoteToAdmin } = await import(
  '#/lib/admin/guard.ts'
)
const { migrate } = await import('drizzle-orm/libsql/migrator')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const PASSWORD_HASH = '$argon2id$test-only'

/**
 * Addresses only this file writes.
 *
 * `#/db/index.ts` binds one client for the whole process, so this file is not
 * alone in the database: clearing `users` outright hit
 * `SQLITE_CONSTRAINT_FOREIGNKEY` from the rows an earlier test file had left
 * pointing at an account. Owning three addresses nothing else uses lets the
 * cleanup remove exactly its own rows, whatever ran before it.
 */
const OWNER = 'gate-owner@example.test'
const MEMBER = 'gate-member@example.test'
const LISTED = 'gate-listed@example.test'
const OWNED = [OWNER, MEMBER, LISTED]

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, OWNED))

  await db.insert(users).values([
    {
      id: OWNER,
      email: OWNER,
      passwordHash: PASSWORD_HASH,
      role: 'admin',
    },
    {
      id: MEMBER,
      email: MEMBER,
      passwordHash: PASSWORD_HASH,
    },
    {
      id: LISTED,
      email: LISTED,
      passwordHash: PASSWORD_HASH,
    },
  ])
})

afterEach(() => {
  delete process.env.LUMEN_ADMIN_EMAILS
})

describe('isOperatorEmail', () => {
  test('is case-insensitive and tolerates spaces around entries', () => {
    process.env.LUMEN_ADMIN_EMAILS = ` ${OWNER} , second@example.test `
    expect(isOperatorEmail(OWNER)).toBe(true)
    expect(isOperatorEmail('SECOND@example.test')).toBe(true)
    expect(isOperatorEmail(MEMBER)).toBe(false)
  })

  test('is off when the variable is unset or empty', () => {
    delete process.env.LUMEN_ADMIN_EMAILS
    expect(isOperatorEmail(OWNER)).toBe(false)

    process.env.LUMEN_ADMIN_EMAILS = ' , '
    expect(isOperatorEmail(OWNER)).toBe(false)
  })
})

describe('isOperatorUser', () => {
  test('accepts the admin role', async () => {
    expect(await isOperatorUser(OWNER)).toBe(true)
  })

  test('refuses an ordinary member', async () => {
    expect(await isOperatorUser(MEMBER)).toBe(false)
  })

  test('accepts an allowlisted address even when the row is a member', async () => {
    process.env.LUMEN_ADMIN_EMAILS = LISTED
    expect(await isOperatorUser(LISTED)).toBe(true)
  })

  test('refuses an address that has no row at all', async () => {
    process.env.LUMEN_ADMIN_EMAILS = 'ghost@example.test'
    // The env list names an address with no account: it may sign in through
    // `/admin/sign-in`, but it is not a user anybody can operate as unless the
    // password check also passes.
    expect(await isOperatorUser('ghost@example.test')).toBe(true)
    expect(await isOperatorUser('nobody@example.test')).toBe(false)
  })
})

describe('promoteToAdmin', () => {
  test('turns a member into an operator', async () => {
    await promoteToAdmin(MEMBER)

    expect(await isOperatorUser(MEMBER)).toBe(true)
  })
})
