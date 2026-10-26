/**
 * Invite storage.
 *
 * Two forms of the same code live on the row: the hash redemption looks up by,
 * and ciphertext so the operator can copy a link again. The properties worth
 * testing are that the hash is never the code, that the code round-trips when a
 * key exists, that it is *absent* rather than broken when one does not, and that
 * deleting an invite takes its redemption rows with it.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-invites-repo-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`
// 32 bytes, hex. The same value the auth tests use.
process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)

const { db, initDatabase } = await import('#/db/index.ts')
const {
  accounts,
  inviteRedemptions,
  invites,
  sessions,
  users,
} = await import('#/db/schema.ts')
const { createInvite, deleteInvite, listInvites } = await import(
  '#/lib/invites/repository.ts'
)
const { migrate } = await import('drizzle-orm/libsql/migrator')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(inviteRedemptions)
  await db.delete(invites)
  await db.delete(accounts)
  await db.delete(sessions)
  await db.delete(users)
  process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)
})

afterEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)
})

describe('createInvite', () => {
  test('stores a hash and ciphertext, never the code itself', async () => {
    const created = await createInvite({ email: 'ada@example.com' })

    const row = await db.query.invites.findFirst({
      where: eq(invites.id, created.id),
    })

    expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.codeHash).not.toContain(created.code)
    expect(row?.codeEncrypted?.startsWith('v1:')).toBe(true)
    expect(row?.codeEncrypted).not.toContain(created.code)
  })

  test('the stored code can be read back for copying a link', async () => {
    const created = await createInvite({ label: 'Ada' })

    const summaries = await listInvites()

    // The grouped form, which is what a link carries.
    expect(summaries[0].code).toBe(created.formattedCode)
  })

  test('leaves the code unreadable when no encryption key is configured', async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY

    const created = await createInvite()
    const summaries = await listInvites()

    // The invite still works — redemption is by hash — but `/admin` cannot
    // pretend it can show a link it does not have.
    expect(summaries[0].code).toBeNull()
    expect(created.code).toHaveLength(12)
  })
})

describe('deleteInvite', () => {
  test('removes the invite and its redemption rows', async () => {
    const created = await createInvite({ email: 'ada@example.com' })

    await db.insert(users).values({
      id: 'ada@example.com',
      email: 'ada@example.com',
      passwordHash: '$argon2id$test-only',
    })

    await db.insert(inviteRedemptions).values({
      id: 'redemption-1',
      inviteId: created.id,
      userId: 'ada@example.com',
    })

    expect(await deleteInvite(created.id)).toBe(true)
    expect(await db.query.invites.findMany()).toHaveLength(0)
    expect(await db.query.inviteRedemptions.findMany()).toHaveLength(0)
  })

  test('reports false for an invite that is already gone', async () => {
    expect(await deleteInvite('does-not-exist')).toBe(false)
  })
})
