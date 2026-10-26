import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-contact-context-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const { accounts, contactContexts, users } = await import('#/db/schema.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')
const { getContactContext, saveContactContext } = await import('./context.ts')

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
  await db.delete(contactContexts)
  await db.delete(accounts)
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
      roleCompany: 'CEO of Acme',
      relationship: 'Met through the founders group',
      topics: 'Hiring and partnership',
      currentWork: 'Launching a new product',
      importance: 9,
    })

    expect(saved?.email).toBe(CONTACT)
    expect(await getContactContext(ALICE, 'ceo@example.net')).toEqual(saved)
    expect(await getContactContext(BOB, CONTACT)).toBeNull()
  })

  test('trims fields and deletes a profile when all notes are cleared', async () => {
    await saveContactContext(ALICE, CONTACT, {
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
      roleCompany: 'x'.repeat(161),
      relationship: '',
      topics: '',
      currentWork: '',
      importance: null,
    })

    expect(saved).toBeNull()
    expect(await getContactContext(ALICE, CONTACT)).toBeNull()
  })
})
