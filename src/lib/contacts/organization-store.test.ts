import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-org-store-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const { contactOrganizations, users } = await import('#/db/schema.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')
const {
  acceptOrganizationFocusSuggestion,
  dismissOrganizationFocusSuggestion,
  listOrganizationRecords,
  setOrganizationFocus,
  suggestOrganizationFocus,
} = await import('./organization-store.ts')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

// A user of its own: the suite shares one database with the other contact
// tests, so clearing `users` here would trip their foreign keys. Only this
// user's organisation rows are cleared between tests.
const ALICE = 'org-store@example.com'

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(contactOrganizations)
  await db
    .insert(users)
    .values({ id: ALICE, email: ALICE, passwordHash: '$argon2id$v=19$m=1$s$h' })
    .onConflictDoNothing()
})

describe('organisation descriptions', () => {
  test('queues a mail-stated line instead of making it the description', async () => {
    await suggestOrganizationFocus(
      ALICE,
      'jane@acme.com',
      '  builds\nwarehouse  robots ',
    )

    let record = (await listOrganizationRecords(ALICE)).get('acme.com')
    expect(record).toEqual({
      domain: 'acme.com',
      focus: null,
      source: null,
      suggestedFocus: 'builds warehouse robots',
    })

    expect(await acceptOrganizationFocusSuggestion(ALICE, 'acme.com')).toBe(
      true,
    )
    record = (await listOrganizationRecords(ALICE)).get('acme.com')
    expect(record).toEqual({
      domain: 'acme.com',
      focus: 'builds warehouse robots',
      source: 'mail',
      suggestedFocus: null,
    })
  })

  test('never replaces a description the user wrote', async () => {
    await setOrganizationFocus(ALICE, 'acme.com', 'ISO consultancy')
    await suggestOrganizationFocus(ALICE, 'jane@acme.com', 'builds robots')

    const record = (await listOrganizationRecords(ALICE)).get('acme.com')
    expect(record?.focus).toBe('ISO consultancy')
    expect(record?.source).toBe('user')
    expect(record?.suggestedFocus).toBeNull()
  })

  test('shares one description across everyone at the domain', async () => {
    await suggestOrganizationFocus(ALICE, 'jane@mail.acme.com', 'builds robots')
    await suggestOrganizationFocus(ALICE, 'bob@acme.com', 'builds robots')

    const records = await listOrganizationRecords(ALICE)
    expect(records.size).toBe(1)
    expect(records.get('acme.com')?.suggestedFocus).toBe('builds robots')
  })

  test('dismisses a pending line without describing the company', async () => {
    await suggestOrganizationFocus(ALICE, 'jane@acme.com', 'builds robots')

    expect(await dismissOrganizationFocusSuggestion(ALICE, 'acme.com')).toBe(
      true,
    )
    const record = (await listOrganizationRecords(ALICE)).get('acme.com')
    expect(record?.suggestedFocus).toBeNull()
    expect(record?.focus).toBeNull()
  })

  test('clears the description and any pending line together', async () => {
    await suggestOrganizationFocus(ALICE, 'jane@acme.com', 'builds robots')
    expect(await setOrganizationFocus(ALICE, 'acme.com', '  ')).toBe(true)

    expect((await listOrganizationRecords(ALICE)).get('acme.com')).toEqual({
      domain: 'acme.com',
      focus: null,
      source: null,
      suggestedFocus: null,
    })
  })

  test('does not file a personal mailbox as a company', async () => {
    await suggestOrganizationFocus(ALICE, 'jane@gmail.com', 'builds robots')
    expect((await listOrganizationRecords(ALICE)).size).toBe(0)
  })
})
