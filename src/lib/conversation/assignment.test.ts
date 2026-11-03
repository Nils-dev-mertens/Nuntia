import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-assignment-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const { accounts, conversations, memberships, users } =
  await import('#/db/schema.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')
const { ensureWorkspace, soloOrganizationId } =
  await import('#/lib/organization/workspace.ts')
const {
  assignConversation,
  getConversationAssignedTo,
  getConversationClusterByThreadId,
} = await import('./repository.ts')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

/**
 * A fresh mailbox and its owner per test.
 *
 * Addresses are unique so this file does not collide with another suite's rows in
 * the shared test process — the same reason the workspace tests generate them.
 */
let fixtureCount = 0
async function fixture() {
  fixtureCount += 1
  const suffix = `${process.pid}-${fixtureCount}`
  const owner = `assign-owner-${suffix}@example.com`
  const member = `assign-member-${suffix}@example.com`
  const stranger = `assign-stranger-${suffix}@example.com`
  const threadId = `thread-${suffix}`

  for (const email of [owner, member, stranger]) {
    await db
      .insert(users)
      .values({ id: email, email, passwordHash: '$argon2id$v=19$m=1$s$h' })
  }

  await db.insert(accounts).values({
    id: owner,
    email: owner,
    userId: owner,
    refreshTokenEncrypted: 'v1:a:b:c',
  })

  await db.insert(conversations).values({
    id: `${owner}:${threadId}`,
    accountId: owner,
    providerThreadId: threadId,
    subject: 'Can you take this one?',
    lastMessageAt: new Date(),
  })

  return { owner, member, stranger, threadId }
}

describe('conversation assignment', () => {
  test('hands a thread to a colleague as a reference', async () => {
    const { owner, member, threadId } = await fixture()

    // The workspace has to exist before a membership can point at it.
    await ensureWorkspace(owner)
    await db.insert(memberships).values({
      id: `mem:${member}`,
      organizationId: soloOrganizationId(owner),
      userId: member,
      role: 'member',
    })

    expect(await assignConversation(owner, threadId, member)).toEqual({
      error: null,
    })

    const assigned = await getConversationAssignedTo(member, threadId)
    expect(assigned?.conversation.subject).toBe('Can you take this one?')
    // Still the owner's mail: the assignee's own cluster does not contain it.
    expect(await getConversationClusterByThreadId(member, threadId)).toBeNull()

    // Taking it back is how a hand-over is undone.
    expect(await assignConversation(owner, threadId, null)).toEqual({
      error: null,
    })
    expect(await getConversationAssignedTo(member, threadId)).toBeNull()
  })

  test('refuses someone outside the workspace and keeps it private', async () => {
    const { owner, stranger, threadId } = await fixture()

    expect(await assignConversation(owner, threadId, stranger)).toEqual({
      error: 'That person is not in this workspace.',
    })
    expect(await getConversationAssignedTo(stranger, threadId)).toBeNull()
  })

  test('only the owner of the thread can hand it on', async () => {
    const { owner, member, threadId } = await fixture()

    await ensureWorkspace(owner)
    await db.insert(memberships).values({
      id: `mem:${member}`,
      organizationId: soloOrganizationId(owner),
      userId: member,
      role: 'admin',
    })

    // The member is in the workspace but does not own this mailbox.
    expect(await assignConversation(member, threadId, member)).toEqual({
      error: 'That conversation is not in your mailbox.',
    })
  })
})
