/**
 * The operator gate.
 *
 * Two ways in — the role on the user row and the environment allowlist — and
 * the important property is that neither widens into "any signed-in user".
 * These checks are pure queries, so they run without a request context; the
 * session half is exercised by the dev-server walk instead.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-guard-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const { sessions, users } = await import('#/db/schema.ts')
const { isOperatorEmail, isOperatorUser, promoteToAdmin } = await import(
  '#/lib/admin/guard.ts'
)
const { migrate } = await import('drizzle-orm/libsql/migrator')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const PASSWORD_HASH = '$argon2id$test-only'

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(sessions)
  await db.delete(users)

  await db.insert(users).values([
    {
      id: 'owner@example.com',
      email: 'owner@example.com',
      passwordHash: PASSWORD_HASH,
      role: 'admin',
    },
    {
      id: 'member@example.com',
      email: 'member@example.com',
      passwordHash: PASSWORD_HASH,
    },
    {
      id: 'listed@example.com',
      email: 'listed@example.com',
      passwordHash: PASSWORD_HASH,
    },
  ])
})

afterEach(() => {
  delete process.env.LUMEN_ADMIN_EMAILS
})

describe('isOperatorEmail', () => {
  test('is case-insensitive and tolerates spaces around entries', () => {
    process.env.LUMEN_ADMIN_EMAILS = ' Owner@Example.com , second@example.com '
    expect(isOperatorEmail('owner@example.com')).toBe(true)
    expect(isOperatorEmail('SECOND@example.com')).toBe(true)
    expect(isOperatorEmail('member@example.com')).toBe(false)
  })

  test('is off when the variable is unset or empty', () => {
    delete process.env.LUMEN_ADMIN_EMAILS
    expect(isOperatorEmail('owner@example.com')).toBe(false)

    process.env.LUMEN_ADMIN_EMAILS = ' , '
    expect(isOperatorEmail('owner@example.com')).toBe(false)
  })
})

describe('isOperatorUser', () => {
  test('accepts the admin role', async () => {
    expect(await isOperatorUser('owner@example.com')).toBe(true)
  })

  test('refuses an ordinary member', async () => {
    expect(await isOperatorUser('member@example.com')).toBe(false)
  })

  test('accepts an allowlisted address even when the row is a member', async () => {
    process.env.LUMEN_ADMIN_EMAILS = 'listed@example.com'
    expect(await isOperatorUser('listed@example.com')).toBe(true)
  })

  test('refuses an address that has no row at all', async () => {
    process.env.LUMEN_ADMIN_EMAILS = 'ghost@example.com'
    // The env list names an address with no account: it may sign in through
    // `/admin/sign-in`, but it is not a user anybody can operate as unless the
    // password check also passes.
    expect(await isOperatorUser('ghost@example.com')).toBe(true)
    expect(await isOperatorUser('nobody@example.com')).toBe(false)
  })
})

describe('promoteToAdmin', () => {
  test('turns a member into an operator', async () => {
    await promoteToAdmin('member@example.com')

    expect(await isOperatorUser('member@example.com')).toBe(true)
  })
})
