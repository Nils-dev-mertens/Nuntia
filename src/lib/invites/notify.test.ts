/**
 * The approval email's edges.
 *
 * The send itself needs a provider and a credential, which a unit test cannot
 * have — but the two decisions that matter here can be tested: what the link
 * looks like, and what happens when the operator has no mailbox connected. That
 * second one is the state a fresh install is in, so it has to be a graceful
 * answer rather than a failed approval.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-notify-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const { accounts, invites, sessions, users } = await import('#/db/schema.ts')
const { appUrl, inviteLink, notifyInvite } = await import(
  '#/lib/invites/notify.ts'
)
const { createInvite } = await import('#/lib/invites/repository.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const OPERATOR = 'operator@example.com'

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  delete process.env.LUMEN_APP_URL
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(accounts)
  await db.delete(invites)
  await db.delete(sessions)
  await db.delete(users)

  await db.insert(users).values({
    id: OPERATOR,
    email: OPERATOR,
    passwordHash: '$argon2id$test-only',
    role: 'admin',
  })
})

describe('inviteLink', () => {
  test('is built from LUMEN_APP_URL, without a doubled slash', () => {
    process.env.LUMEN_APP_URL = 'https://nuntia.example/'
    expect(appUrl()).toBe('https://nuntia.example')
    expect(inviteLink('A1B2C3D4E5F6')).toBe(
      'https://nuntia.example/join/A1B2-C3D4-E5F6',
    )
  })

  test('falls back to localhost when nothing is configured', () => {
    delete process.env.LUMEN_APP_URL
    expect(inviteLink('A1B2C3D4E5F6')).toContain(
      'http://localhost:3000/join/A1B2-C3D4-E5F6',
    )
  })
})

describe('notifyInvite', () => {
  test('keeps the invite and records why nothing was sent when no mailbox is connected', async () => {
    const invite = await createInvite({
      email: 'ada@example.com',
      createdBy: OPERATOR,
    })

    const result = await notifyInvite({
      inviteId: invite.id,
      code: invite.code,
      to: 'ada@example.com',
      operatorId: OPERATOR,
    })

    expect(result.sent).toBe(false)
    expect(result.reason).toContain('No mailbox is connected')

    // The approval is a decision about a person; a delivery detail must not
    // undo it. The row says what happened so `/admin` can offer a new link.
    const row = await db.query.invites.findFirst({
      where: eq(invites.id, invite.id),
    })
    expect(row?.notifiedAt).toBeNull()
    expect(row?.notifyError).toContain('No mailbox is connected')
    expect(row?.revokedAt).toBeNull()
  })
})
