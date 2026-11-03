import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-workspace-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`
process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)

const { db, initDatabase } = await import('#/db/index.ts')
const { memberships, users } = await import('#/db/schema.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')
const { ensureWorkspace, soloOrganizationId } =
  await import('#/lib/organization/workspace.ts')
const { renameWorkspace, setMemberRole, listWorkspaceMembers } =
  await import('./members.ts')
const { getAiSettings, saveAiSettings } = await import('#/lib/ai/settings.ts')
const { listOrganizationLabels, saveOrganizationLabels } =
  await import('./store.ts')

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
 * A fresh workspace per test.
 *
 * The test process is shared, so fixed addresses would collide with another
 * suite's user rows — and deleting them all is not this file's business. A
 * counter gives every test its own users and its own `org:<user>` workspace,
 * which is also the only isolation these assertions need.
 */
let fixtureCount = 0
async function fixture() {
  fixtureCount += 1
  const suffix = `${process.pid}-${fixtureCount}`
  const owner = `owner-${suffix}@example.com`
  const member = `member-${suffix}@example.com`
  const stranger = `stranger-${suffix}@example.com`

  for (const email of [owner, member, stranger]) {
    await db
      .insert(users)
      .values({ id: email, email, passwordHash: '$argon2id$v=19$m=1$s$h' })
  }

  return { owner, member, stranger }
}

/** Put a second person in the owner's workspace, the way an invite would. */
async function addToWorkspace(
  owner: string,
  userId: string,
  role: 'admin' | 'member',
) {
  await db.insert(memberships).values({
    id: `mem:${userId}`,
    organizationId: soloOrganizationId(owner),
    userId,
    role,
  })
}

describe('workspace roles', () => {
  test('a member can read the workspace and change nothing', async () => {
    const { owner, member } = await fixture()
    await ensureWorkspace(owner)
    await addToWorkspace(owner, member, 'member')

    expect((await listWorkspaceMembers(soloOrganizationId(owner))).length).toBe(
      2,
    )
    expect(await renameWorkspace(member, 'Taken over')).toEqual({
      error: 'Only an owner or admin can rename this workspace.',
      name: null,
    })
    expect(await setMemberRole(member, owner, 'member')).toEqual({
      error: 'Only the owner can change roles.',
    })
  })

  test('an admin may rename but not change roles', async () => {
    const { owner, member } = await fixture()
    await ensureWorkspace(owner)
    await addToWorkspace(owner, member, 'admin')

    expect(await renameWorkspace(member, 'Acme mail')).toEqual({
      error: null,
      name: 'Acme mail',
    })
    expect(await setMemberRole(member, owner, 'member')).toEqual({
      error: 'Only the owner can change roles.',
    })
  })

  test('the owner changes roles and cannot leave the workspace ownerless', async () => {
    const { owner, member } = await fixture()
    await ensureWorkspace(owner)
    await addToWorkspace(owner, member, 'member')

    expect(await setMemberRole(owner, member, 'admin')).toEqual({ error: null })

    // Demoting the only owner would leave nobody able to change the sharing
    // settings, with no way back from inside the app.
    expect(await setMemberRole(owner, owner, 'member')).toEqual({
      error:
        'This is the only owner. Make someone else an owner first, so the workspace is never left without one.',
    })
  })
})

describe('workspace labels', () => {
  test('are the workspace’s filing, not one member’s', async () => {
    const { owner, member, stranger } = await fixture()
    await ensureWorkspace(owner)
    await addToWorkspace(owner, member, 'member')

    expect(
      await saveOrganizationLabels(owner, [
        {
          id: 'invoices',
          name: 'Invoices',
          description: 'Bills and receipts',
          enabled: true,
          rules: [{ id: 'r1', field: 'subject-contains', value: 'invoice' }],
        },
      ]),
    ).not.toBeNull()

    const forMember = await listOrganizationLabels(member)
    expect(forMember.map((label) => label.name)).toEqual(['Invoices'])
    // …and someone in another workspace sees none of it.
    expect(await listOrganizationLabels(stranger)).toEqual([])
  })
})

describe('workspace AI settings', () => {
  test('belong to the workspace, so a member drafts with the owner’s key', async () => {
    const { owner, member, stranger } = await fixture()
    await ensureWorkspace(owner)
    await addToWorkspace(owner, member, 'member')

    await saveAiSettings(owner, {
      jevModel: 'jev-latest',
      llmProvider: 'gemini',
      llmModel: null,
      suggestReplyMinImportance: 7,
      jevApiKey: 'workspace-key',
    })

    const forMember = await getAiSettings(member)
    expect(forMember.jevConfigured).toBe(true)
    expect(forMember.suggestReplyMinImportance).toBe(7)
    // The summary carries no secret either way, but the point is that a
    // colleague reads the workspace's configuration rather than an empty one.
    expect(JSON.stringify(forMember)).not.toContain('workspace-key')

    // Someone in a different workspace sees none of it.
    expect((await getAiSettings(stranger)).jevConfigured).toBe(false)
  })
})
