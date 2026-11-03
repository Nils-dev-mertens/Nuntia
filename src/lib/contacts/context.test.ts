import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-contact-context-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const {
  accounts,
  contactContexts,
  memberships,
  organizationClients,
  organizations,
  users,
} = await import('#/db/schema.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')
const { getContactContext, saveContactContext } = await import('./context.ts')
const { soloOrganizationId } = await import('#/lib/organization/workspace.ts')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const ALICE = 'alice@example.com'
const BOB = 'bob@example.com'
const CONTACT = 'ceo@example.net'

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  // Workspaces outlive their members' rows only in tests: production has no
  // delete path for an organisation. Clearing them keeps each test's client list
  // its own.
  await db.delete(contactContexts)
  await db.delete(accounts)
  await db.delete(organizationClients)
  await db.delete(organizations)
  await db.delete(users)

  for (const email of [ALICE, BOB]) {
    await db
      .insert(users)
      .values({ id: email, email, passwordHash: '$argon2id$v=19$m=1$s$h' })
    await db.insert(accounts).values({
      id: email,
      email,
      userId: email,
      refreshTokenEncrypted: 'v1:a:b:c',
    })
  }
})

describe('contact context profiles', () => {
  test('normalizes email and shares one profile across the user’s mailboxes', async () => {
    const saved = await saveContactContext(ALICE, ' CEO@Example.NET ', {
      kind: 'client',
      roleCompany: 'CEO of Acme',
      relationship: 'Met through the founders group',
      topics: 'Hiring and partnership',
      currentWork: 'Launching a new product',
      importance: 9,
    })

    expect(saved?.email).toBe(CONTACT)
    expect(saved?.kind).toBe('client')
    expect(await getContactContext(ALICE, 'ceo@example.net')).toEqual(saved)
    expect(await getContactContext(BOB, CONTACT)).toBeNull()
  })

  test('trims fields and deletes a profile when all notes are cleared', async () => {
    await saveContactContext(ALICE, CONTACT, {
      kind: null,
      roleCompany: ' CEO of Acme ',
      relationship: '',
      topics: '',
      currentWork: '',
      importance: 7,
    })
    expect((await getContactContext(ALICE, CONTACT))?.roleCompany).toBe(
      'CEO of Acme',
    )

    const cleared = await saveContactContext(ALICE, CONTACT, {
      kind: null,
      roleCompany: ' ',
      relationship: '',
      topics: '',
      currentWork: '',
      importance: null,
    })
    expect(cleared).toBeNull()
    expect(await getContactContext(ALICE, CONTACT)).toBeNull()
  })

  test('refuses an importance rating outside 1–10', async () => {
    expect(
      await saveContactContext(ALICE, CONTACT, {
        kind: null,
        roleCompany: '',
        relationship: '',
        topics: '',
        currentWork: '',
        importance: 11,
      }),
    ).toBeNull()
    expect(await getContactContext(ALICE, CONTACT)).toBeNull()
  })

  test('refuses overlong user-authored context without persisting it', async () => {
    const saved = await saveContactContext(ALICE, CONTACT, {
      kind: null,
      roleCompany: 'x'.repeat(161),
      relationship: '',
      topics: '',
      currentWork: '',
      importance: null,
    })

    expect(saved).toBeNull()
    expect(await getContactContext(ALICE, CONTACT)).toBeNull()
  })

  test('keeps a kind on its own, with no notes at all', async () => {
    const saved = await saveContactContext(ALICE, CONTACT, {
      kind: 'client',
      roleCompany: '',
      relationship: '',
      topics: '',
      currentWork: '',
      importance: null,
    })

    // A kind is a reason to keep the row: it is what the Clients section reads,
    // so clearing the notes must not delete the person's kind with them.
    expect(saved?.kind).toBe('client')
    expect(await getContactContext(ALICE, CONTACT)).toEqual(saved)
  })

  test('refuses a kind that is not on the list', async () => {
    const saved = await saveContactContext(ALICE, CONTACT, {
      // Deliberately outside the closed list: a typo must not become a person
      // the inbox silently stops prioritising.
      kind: 'bestie' as never,
      roleCompany: '',
      relationship: '',
      topics: '',
      currentWork: '',
      importance: null,
    })

    expect(saved).toBeNull()
    expect(await getContactContext(ALICE, CONTACT)).toBeNull()
  })

  test('lists only the correspondents that carry a kind', async () => {
    const { listContactKindsByEmail } = await import('./context.ts')

    await saveContactContext(ALICE, CONTACT, {
      kind: 'client',
      roleCompany: '',
      relationship: '',
      topics: '',
      currentWork: '',
      importance: null,
    })
    await saveContactContext(ALICE, 'note@example.net', {
      kind: null,
      roleCompany: 'Just a note',
      relationship: '',
      topics: '',
      currentWork: '',
      importance: null,
    })

    expect([...(await listContactKindsByEmail(ALICE))]).toEqual([
      [CONTACT, 'client'],
    ])
    // Bob is in a workspace of his own, so Alice's list is not his.
    expect((await listContactKindsByEmail(BOB)).size).toBe(0)
  })

  test('shares the client, not the notes, with the rest of the workspace', async () => {
    const { listContactKindsByEmail } = await import('./context.ts')

    // Alice's workspace has to exist before an invite could put anyone in it.
    await saveContactContext(ALICE, CONTACT, {
      kind: 'client',
      roleCompany: 'CEO of Acme',
      relationship: 'Met through the founders group',
      topics: '',
      currentWork: '',
      importance: 9,
    })

    // The membership an invite would create: Bob joins Alice's workspace.
    await db.insert(memberships).values({
      id: 'mem:bob',
      organizationId: soloOrganizationId(ALICE),
      userId: BOB,
      role: 'member',
    })

    await saveContactContext(BOB, CONTACT, {
      kind: 'client',
      roleCompany: '',
      relationship: '',
      topics: '',
      currentWork: '',
      importance: null,
    })

    const seenByBob = await getContactContext(BOB, CONTACT)
    // "Acme is a client" is a company fact …
    expect(seenByBob?.kind).toBe('client')
    expect([...(await listContactKindsByEmail(BOB))]).toEqual([
      [CONTACT, 'client'],
    ])
    // … "Ana prefers short replies" is not.
    expect(seenByBob?.roleCompany).toBe('')
    expect(seenByBob?.importance).toBeNull()
  })
})
