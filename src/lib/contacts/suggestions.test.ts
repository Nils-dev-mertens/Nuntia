/**
 * The recipient list the composer offers.
 *
 * It is built from the contacts table, which is written from every thread's
 * participants — so these tests seed that table the way `saveConversation`
 * leaves it and assert the ordering and the exclusions the picker depends on.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A database of its own, before any module reads DATABASE_URL.
const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-suggestions-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`
process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)

const { db, initDatabase } = await import('#/db/index.ts')
const { accounts, contacts, users } = await import('#/db/schema.ts')
const { listContactSuggestions, recordContactedAddresses } =
  await import('./index.ts')
const { matchContactSuggestions } = await import('./matching.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const ALICE = 'alice@example.com'
const BOB = 'bob@example.com'

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(contacts)
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

/** A learned address, with the timestamp the list is ordered by. */
async function learn(
  accountId: string,
  email: string,
  name: string | null,
  updatedAt: Date,
) {
  await db
    .insert(contacts)
    .values({ accountId, email, name, updatedAt })
    .onConflictDoNothing()
}

describe('listContactSuggestions', () => {
  test('lists what the user has corresponded with, newest first', async () => {
    await learn(ALICE, 'old@example.com', 'Olive Old', new Date(1_000))
    await learn(ALICE, 'new@example.com', 'Nina New', new Date(2_000))

    const suggestions = await listContactSuggestions([ALICE], [ALICE])

    expect(suggestions.map((s) => s.email)).toEqual([
      'new@example.com',
      'old@example.com',
    ])
    expect(suggestions[0]?.name).toBe('Nina New')
  })

  test('keeps an address with no name — a nameless sender is still a person', async () => {
    await learn(ALICE, 'noname@example.com', null, new Date())

    const suggestions = await listContactSuggestions([ALICE], [ALICE])
    expect(suggestions).toEqual([
      {
        email: 'noname@example.com',
        name: null,
        accountId: ALICE,
        lastUsedAt: expect.any(Date),
      },
    ])
  })

  test('folds the same person across mailboxes into one entry', async () => {
    await learn(ALICE, 'shared@example.com', null, new Date(1_000))
    await learn(BOB, 'shared@example.com', 'Sam Shared', new Date(3_000))

    const suggestions = await listContactSuggestions([ALICE, BOB], [ALICE, BOB])

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.email).toBe('shared@example.com')
    // The newest sighting wins, which is the one that carried the name.
    expect(suggestions[0]?.name).toBe('Sam Shared')
    expect(suggestions[0]?.accountId).toBe(BOB)
  })

  test('leaves the user’s own addresses out', async () => {
    await learn(ALICE, ALICE, 'Me', new Date(2_000))
    await learn(ALICE, 'them@example.com', null, new Date(1_000))

    const suggestions = await listContactSuggestions([ALICE], [ALICE, BOB])

    expect(suggestions.map((s) => s.email)).toEqual(['them@example.com'])
  })

  test('remembers addresses after a send, without erasing a known name', async () => {
    await learn(ALICE, 'named@example.com', 'Nina Named', new Date(1_000))

    await recordContactedAddresses(ALICE, [
      'NAMEd@example.com',
      'fresh@example.com',
      '  ',
    ])

    const suggestions = await listContactSuggestions([ALICE], [ALICE])
    expect(suggestions.map((s) => s.email)).toEqual([
      'fresh@example.com',
      'named@example.com',
    ])
    expect(suggestions[1]?.name).toBe('Nina Named')
  })

  test('matches what was typed by name or address, and never repeats a chosen one', () => {
    const pool = [
      { email: 'alice@example.com', name: 'Alice Anders' },
      { email: 'bob@example.com', name: 'Bob Brown' },
      { email: 'alina@example.com', name: null },
    ]

    expect(
      matchContactSuggestions(pool, 'ali', []).map((s) => s.email),
    ).toEqual(['alice@example.com', 'alina@example.com'])
    expect(
      matchContactSuggestions(pool, 'brown', []).map((s) => s.email),
    ).toEqual(['bob@example.com'])
    expect(
      matchContactSuggestions(pool, 'ali', ['ALICE@example.com']).map(
        (s) => s.email,
      ),
    ).toEqual(['alina@example.com'])
    // An empty field offers the most recent few, not the whole address book.
    expect(matchContactSuggestions(pool, '', [], 1)).toHaveLength(1)
  })

  test('caps the list, and is empty when there are no mailboxes', async () => {
    for (let i = 0; i < 5; i++) {
      await learn(ALICE, `p${i}@example.com`, null, new Date(i + 1))
    }

    expect(await listContactSuggestions([ALICE], [], 3)).toHaveLength(3)
    expect(await listContactSuggestions([], [])).toEqual([])
  })
})
