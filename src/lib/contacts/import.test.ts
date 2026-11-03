import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-contact-import-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const { accounts, contactContexts, organizationClients, organizations, users } =
  await import('#/db/schema.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')
const { getContactContext, saveContactContext } = await import('./context.ts')
const { importContactKinds, parseContactImport } = await import('./import.ts')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const ALICE = 'alice@example.com'
const CONTACT = 'ceo@example.net'

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  // Mailboxes go before users: other suites in the shared test process leave
  // accounts behind, and `users` is the row they point at.
  await db.delete(contactContexts)
  await db.delete(accounts)
  await db.delete(organizationClients)
  await db.delete(organizations)
  await db.delete(users)
  await db
    .insert(users)
    .values({ id: ALICE, email: ALICE, passwordHash: '$argon2id$v=19$m=1$s$h' })
})

describe('client list import', () => {
  test('reads addresses with or without a kind, and ignores the CSV furniture', () => {
    const parsed = parseContactImport(
      [
        'email,kind',
        '# the Q3 client list',
        'CEO@Example.NET',
        'ana@acme.test, client',
        'sam@vendor.test ; Vendor',
        '',
        'ana@acme.test, prospect',
      ].join('\n'),
    )

    expect(parsed.entries).toEqual([
      { email: CONTACT, kind: 'client' },
      { email: 'ana@acme.test', kind: 'client' },
      { email: 'sam@vendor.test', kind: 'vendor' },
    ])
    // The duplicate is folded, not reported: pasting the same export twice is
    // something a person does, and the first occurrence is the one they meant.
    expect(parsed.skipped).toEqual([])
  })

  test('reports a line it cannot read instead of guessing', () => {
    const parsed = parseContactImport(
      ['not an address', 'someone@acme.test, Acme Inc', 'ok@acme.test'].join(
        '\n',
      ),
      'partner',
    )

    expect(parsed.entries).toEqual([{ email: 'ok@acme.test', kind: 'partner' }])
    expect(parsed.skipped).toEqual([
      'not an address',
      'someone@acme.test, Acme Inc',
    ])
  })

  test('writes only the kind, so an existing note survives', async () => {
    await saveContactContext(ALICE, CONTACT, {
      kind: null,
      roleCompany: 'CEO of Acme',
      relationship: 'Met through the founders group',
      topics: '',
      currentWork: '',
      importance: 9,
    })

    const parsed = parseContactImport(`${CONTACT}\nfresh@acme.test`)
    expect(await importContactKinds(ALICE, parsed.entries)).toBe(2)

    const kept = await getContactContext(ALICE, CONTACT)
    expect(kept?.kind).toBe('client')
    expect(kept?.roleCompany).toBe('CEO of Acme')
    expect(kept?.importance).toBe(9)

    // A new address is created with the kind and nothing else.
    const created = await getContactContext(ALICE, 'fresh@acme.test')
    expect(created?.kind).toBe('client')
    expect(created?.importance).toBeNull()
  })
})
