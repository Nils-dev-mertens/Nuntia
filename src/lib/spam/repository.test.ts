import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-spam-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const { accounts, spamRules, spamSenderSignals, users } =
  await import('#/db/schema.ts')
const {
  listSpamRules,
  listSpamSenders,
  matchingSpamRules,
  recordSpamSender,
  saveSpamRules,
} = await import('./repository.ts')

await initDatabase()

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(spamSenderSignals)
  await db.delete(spamRules)
  await db.delete(accounts)
  await db.delete(users)
  await db.insert(users).values({
    id: 'alice@example.com',
    email: 'alice@example.com',
    passwordHash: '$argon2id$v=19$m=1$s$h',
  })
  await db.insert(accounts).values({
    id: 'alice@example.com',
    email: 'alice@example.com',
    userId: 'alice@example.com',
    refreshTokenEncrypted: 'not-a-real-token',
  })
})

describe('learned spam senders', () => {
  test('a marked sender is remembered, and a correction takes it back', async () => {
    await recordSpamSender('alice@example.com', 'Deals@Example.com', true)
    expect(await listSpamSenders('alice@example.com')).toEqual(
      new Set(['deals@example.com']),
    )

    await recordSpamSender('alice@example.com', 'deals@example.com', false)
    expect(await listSpamSenders('alice@example.com')).toEqual(new Set())
  })

  test('ignores an address that is not one', async () => {
    await recordSpamSender('alice@example.com', 'not an address', true)
    expect(await listSpamSenders('alice@example.com')).toEqual(new Set())
  })
})

describe('spam rules', () => {
  test('persists, replaces and matches email, domain and subject rules', async () => {
    await saveSpamRules('alice@example.com', [
      { field: 'sender-email', value: ' Deals@Example.com ' },
      { field: 'sender-domain', value: 'spam.example' },
      { field: 'subject-contains', value: 'free crypto' },
    ])

    const rules = await listSpamRules('alice@example.com')
    expect(rules.map((rule) => rule.field)).toEqual([
      'sender-email',
      'sender-domain',
      'subject-contains',
    ])
    expect(rules[0].value).toBe('deals@example.com')

    expect(
      matchingSpamRules(rules, {
        from: 'deals@example.com',
        subject: 'hello',
      }),
    ).toHaveLength(1)

    expect(
      matchingSpamRules(rules, {
        from: 'someone@spam.example',
        subject: 'hello',
      }),
    ).toHaveLength(1)

    expect(
      matchingSpamRules(rules, {
        from: 'friend@example.com',
        subject: 'FREE CRYPTO now',
      }),
    ).toHaveLength(1)

    expect(
      matchingSpamRules(rules, {
        from: 'friend@example.com',
        subject: 'lunch',
      }),
    ).toHaveLength(0)
  })

  test('an invalid payload leaves the stored rules alone', async () => {
    await saveSpamRules('alice@example.com', [
      { field: 'sender-domain', value: 'spam.example' },
    ])

    expect(await saveSpamRules('alice@example.com', 'nope')).toBeNull()
    expect(await listSpamRules('alice@example.com')).toHaveLength(1)
  })
})
