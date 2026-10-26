/**
 * The gate itself.
 *
 * Three properties, each one a lockout avoided: the default mode is the beta,
 * the environment bootstrap does not create users while the gate is on, and
 * password registration is refused even if a server function is called
 * directly rather than through its route.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-access-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const { users } = await import('#/db/schema.ts')
const { accessMode, invitesOnly } = await import('#/lib/auth/access.ts')
const { bootstrapDefaultUser, registerUser } = await import(
  '#/lib/auth/users.ts'
)
const { migrate } = await import('drizzle-orm/libsql/migrator')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const PASSWORD = 'correct horse battery'

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(users)
  process.env.LUMEN_DEFAULT_USER_EMAIL = 'owner@example.com'
  process.env.LUMEN_DEFAULT_USER_PASSWORD = PASSWORD
})

afterEach(() => {
  delete process.env.LUMEN_DEFAULT_USER_EMAIL
  delete process.env.LUMEN_DEFAULT_USER_PASSWORD
  // Back to the suite default (see `test/setup.ts`), never unset: leaving the
  // variable absent would flip every later file into invite mode, where
  // password registration is refused.
  process.env.LUMEN_ACCESS_MODE = 'login'
})

describe('accessMode', () => {
  test('is the invite beta by default, even with no configuration', () => {
    delete process.env.LUMEN_ACCESS_MODE
    expect(accessMode()).toBe('invite')
    expect(invitesOnly()).toBe(true)
  })

  test('is login only when asked for by name', () => {
    process.env.LUMEN_ACCESS_MODE = ' LOGIN '
    expect(accessMode()).toBe('login')
    expect(invitesOnly()).toBe(false)
  })

  test('treats anything unknown as the safer default', () => {
    process.env.LUMEN_ACCESS_MODE = 'open'
    expect(accessMode()).toBe('invite')
  })
})

describe('invite mode', () => {
  test('ignores the environment bootstrap, so nobody is created uninvited', async () => {
    process.env.LUMEN_ACCESS_MODE = 'invite'

    await bootstrapDefaultUser()

    expect(await db.query.users.findMany()).toHaveLength(0)
  })

  test('refuses password registration at the server function, not only at the route', async () => {
    process.env.LUMEN_ACCESS_MODE = 'invite'

    const result = await registerUser({
      email: 'ada@example.com',
      password: PASSWORD,
    })

    expect(result).toEqual({
      error: 'Registration is invite-only right now.',
    })
    expect(await db.query.users.findMany()).toHaveLength(0)
  })
})

describe('login mode', () => {
  test('still bootstraps the configured first user', async () => {
    process.env.LUMEN_ACCESS_MODE = 'login'

    await bootstrapDefaultUser()

    const rows = await db.query.users.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('owner@example.com')
  })
})
