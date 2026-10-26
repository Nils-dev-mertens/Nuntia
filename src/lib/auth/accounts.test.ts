/**
 * Accounts: who may sign in, and what they may reach.
 *
 * The interesting properties are all about *not* crossing a line — one user must
 * not see another's mailbox, a mailbox must not move between owners, and a
 * password must not be recoverable from the row. Each test below is one of those
 * lines.
 *
 * Sessions are exercised at the database level here: the cookie half needs a
 * request context, which only exists in the dev-server smoke test.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

// A database of its own, before any module reads DATABASE_URL.
const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-auth-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`
process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)

const { db, initDatabase } = await import('#/db/index.ts')
const { accounts, appSettings, sessions, users } =
  await import('#/db/schema.ts')
const {
  assertOwnedAccount,
  bootstrapDefaultUser,
  deleteAccount,
  ensureBootstrapUser,
  listAccounts,
  listSessions,
  ownsAccount,
  registerUser,
  authenticateUser,
  revokeAllSessions,
  upsertAccount,
} = await import('#/lib/auth/index.ts')
const { getAiSettings, saveAiSettings } = await import('#/lib/ai/settings.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const ALICE = 'alice@example.com'
const BOB = 'bob@example.com'
const PASSWORD = 'correct horse battery'

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(appSettings)
  await db.delete(sessions)
  await db.delete(accounts)
  await db.delete(users)
  delete process.env.LUMEN_DEFAULT_USER_EMAIL
  delete process.env.LUMEN_DEFAULT_USER_PASSWORD
})

/** Create the users a test needs. Mailboxes reference them. */
async function signUp(...emails: string[]) {
  for (const email of emails) {
    const created = await registerUser({ email, password: PASSWORD })
    if ('error' in created) throw new Error(created.error)
  }
}

/** An account row with the given owner, as a connection would leave it. */
async function connectMailbox(email: string, userId: string | null) {
  await db.insert(accounts).values({
    id: email,
    email,
    userId,
    refreshTokenEncrypted: 'v1:a:b:c',
  })
}

describe('users', () => {
  test('stores a hash, never the password, and rejects a wrong one', async () => {
    const created = await registerUser({ email: ALICE, password: PASSWORD })
    expect('user' in created).toBe(true)

    const [row] = await db.select().from(users).where(eq(users.id, ALICE))
    // The stored value is an argon2id hash, and the password is not in it.
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true)
    expect(row.passwordHash).not.toContain(PASSWORD)

    const wrong = await authenticateUser(ALICE, 'not the password')
    expect('error' in wrong).toBe(true)

    const right = await authenticateUser(ALICE, PASSWORD)
    expect('user' in right).toBe(true)
  })

  test('refuses a short password, a bad address and a duplicate sign-up', async () => {
    expect(
      'error' in (await registerUser({ email: ALICE, password: 'short' })),
    ).toBe(true)
    expect(
      'error' in
        (await registerUser({ email: 'not-an-address', password: PASSWORD })),
    ).toBe(true)

    await registerUser({ email: ALICE, password: PASSWORD })
    const again = await registerUser({ email: ALICE, password: PASSWORD })
    expect('error' in again).toBe(true)
    // Case does not create a second account for the same address.
    expect(
      'error' in
        (await registerUser({
          email: ALICE.toUpperCase(),
          password: PASSWORD,
        })),
    ).toBe(true)
  })

  test('an unknown address costs the same as a wrong password', async () => {
    await registerUser({ email: ALICE, password: PASSWORD })

    const missing = await authenticateUser(BOB, PASSWORD)
    const wrong = await authenticateUser(ALICE, PASSWORD + 'x')

    // One sentence for both, so the form cannot be used to enumerate addresses.
    expect(missing).toEqual(wrong)
  })

  test('the first sign-up adopts mailboxes and settings from before accounts existed', async () => {
    await connectMailbox('old@example.com', null)
    await db.insert(appSettings).values({ id: 'app', userId: null })

    await registerUser({ email: ALICE, password: PASSWORD })

    expect((await listAccounts(ALICE)).map((a) => a.id)).toEqual([
      'old@example.com',
    ])
    const adopted = await db.query.appSettings.findFirst()
    expect(adopted?.userId).toBe(ALICE)
  })

  test('a later sign-up adopts nothing', async () => {
    await registerUser({ email: ALICE, password: PASSWORD })
    await connectMailbox('old@example.com', null)

    await registerUser({ email: BOB, password: PASSWORD })

    // The orphan row stays unowned rather than going to whoever signed up last:
    // only the first account can be the one the pre-accounts mail belonged to.
    expect(await listAccounts(BOB)).toEqual([])
    const rows = await db.select().from(accounts)
    expect(rows.map((row) => row.userId)).toEqual([null])
  })
})

describe('the default user from the environment', () => {
  test('is created on first use and adopts the pre-accounts rows', async () => {
    process.env.LUMEN_DEFAULT_USER_EMAIL = 'owner@example.com'
    process.env.LUMEN_DEFAULT_USER_PASSWORD = PASSWORD
    await connectMailbox('old@example.com', null)

    await bootstrapDefaultUser()

    const [owner] = await db.select().from(users)
    expect(owner.id).toBe('owner@example.com')
    expect(owner.passwordHash.startsWith('$argon2id$')).toBe(true)
    expect((await listAccounts('owner@example.com')).map((a) => a.id)).toEqual([
      'old@example.com',
    ])

    // Signing in with the configured password works, which is the point of it.
    expect(
      'user' in (await authenticateUser('owner@example.com', PASSWORD)),
    ).toBe(true)
  })

  test('is not created when the variables are unset or unusable', async () => {
    await bootstrapDefaultUser()
    expect(await db.select().from(users)).toEqual([])

    process.env.LUMEN_DEFAULT_USER_EMAIL = 'owner@example.com'
    process.env.LUMEN_DEFAULT_USER_PASSWORD = 'too-short'
    await bootstrapDefaultUser()
    expect(await db.select().from(users)).toEqual([])
  })

  test('never overrides an account somebody already created', async () => {
    await registerUser({ email: ALICE, password: PASSWORD })
    process.env.LUMEN_DEFAULT_USER_EMAIL = 'owner@example.com'
    process.env.LUMEN_DEFAULT_USER_PASSWORD = PASSWORD

    await bootstrapDefaultUser()

    const rows = await db.select().from(users)
    expect(rows.map((row) => row.id)).toEqual([ALICE])
  })

  test('is memoised, so a request never pays for it twice', async () => {
    process.env.LUMEN_DEFAULT_USER_EMAIL = 'owner@example.com'
    process.env.LUMEN_DEFAULT_USER_PASSWORD = PASSWORD

    // Twice, as every request does.
    await ensureBootstrapUser()
    await ensureBootstrapUser()

    expect((await db.select().from(users)).length).toBe(1)
  })
})

describe('mailbox ownership', () => {
  test('lists one user’s mailboxes, not the install’s', async () => {
    await signUp(ALICE, BOB)
    await connectMailbox('alice@mail.example', ALICE)
    await connectMailbox('bob@mail.example', BOB)

    expect((await listAccounts(ALICE)).map((a) => a.id)).toEqual([
      'alice@mail.example',
    ])
    expect((await listAccounts(BOB)).map((a) => a.id)).toEqual([
      'bob@mail.example',
    ])
    // An unknown user matches nothing rather than everything.
    expect(await listAccounts('nobody@example.com')).toEqual([])
  })

  test('refuses to hand a mailbox to a second owner', async () => {
    await signUp(ALICE, BOB)
    await upsertAccount({
      userId: ALICE,
      email: 'shared@example.com',
      provider: 'google',
      refreshToken: 'refresh-token-alice',
    })

    // The same address connecting again as somebody else would move the row, and
    // with it every conversation synced into it.
    await expect(
      upsertAccount({
        userId: BOB,
        email: 'shared@example.com',
        provider: 'google',
        refreshToken: 'refresh-token-bob',
      }),
    ).rejects.toThrow(/already connected/i)

    const rows = await db.select().from(accounts)
    expect(rows[0].userId).toBe(ALICE)
  })

  test('re-connecting the same owner keeps the row and takes the new token', async () => {
    await signUp(ALICE)
    await upsertAccount({
      userId: ALICE,
      email: 'alice@mail.example',
      provider: 'google',
      refreshToken: 'first',
    })
    await upsertAccount({
      userId: ALICE,
      email: 'alice@mail.example',
      provider: 'microsoft',
      refreshToken: 'second',
    })

    const rows = await db.select().from(accounts)
    expect(rows).toHaveLength(1)
    expect(rows[0].provider).toBe('microsoft')
    expect(rows[0].refreshTokenEncrypted).not.toBe('second')
  })

  test('guards the paths that take an account id from a request', async () => {
    await signUp(ALICE, BOB)
    await connectMailbox('alice@mail.example', ALICE)

    expect(await ownsAccount(ALICE, 'alice@mail.example')).toBe(true)
    expect(await ownsAccount(BOB, 'alice@mail.example')).toBe(false)
    await expect(assertOwnedAccount(BOB, 'alice@mail.example')).rejects.toThrow(
      /not connected to this account/i,
    )
  })

  test('a pre-accounts mailbox is owned by nobody, and reachable by nobody', async () => {
    await connectMailbox('old@example.com', null)

    expect(await listAccounts(ALICE)).toEqual([])
    expect(await ownsAccount(ALICE, 'old@example.com')).toBe(false)
  })

  test('only the owner can delete a mailbox', async () => {
    await signUp(ALICE, BOB)
    await connectMailbox('alice@mail.example', ALICE)

    await deleteAccount(BOB, 'alice@mail.example')
    expect(await db.select().from(accounts)).toHaveLength(1)

    await deleteAccount(ALICE, 'alice@mail.example')
    expect(await db.select().from(accounts)).toHaveLength(0)
  })
})

describe('AI settings', () => {
  test('are per user: one person’s key is not another’s', async () => {
    await signUp(ALICE, BOB)
    await saveAiSettings(ALICE, {
      jevModel: 'jev-latest',
      llmProvider: 'gemini',
      llmModel: null,
      suggestReplyMinImportance: 6,
      jevApiKey: 'alice-key',
      llmApiKey: 'alice-llm-key',
    })

    expect((await getAiSettings(ALICE)).jevConfigured).toBe(true)
    // Bob has no row at all, so nothing of Alice's is visible to him.
    expect((await getAiSettings(BOB)).jevConfigured).toBe(false)
    expect((await getAiSettings(BOB)).llmConfigured).toBe(false)
    expect(JSON.stringify(await getAiSettings(BOB))).not.toContain('alice-key')

    // And his own write cannot collide with hers.
    await saveAiSettings(BOB, {
      jevModel: null,
      llmProvider: null,
      llmModel: null,
      suggestReplyMinImportance: 8,
      jevApiKey: 'bob-key',
    })
    expect((await getAiSettings(ALICE)).suggestReplyMinImportance).toBe(6)
    expect((await getAiSettings(BOB)).suggestReplyMinImportance).toBe(8)
  })

  test('write to the row the first sign-up adopted', async () => {
    await signUp(ALICE)

    // The pre-accounts row carries the old `id`; saving for its new owner has to
    // update that row rather than fail on the primary key.
    await db.insert(appSettings).values({ id: 'app', userId: ALICE })

    await saveAiSettings(ALICE, {
      jevModel: null,
      llmProvider: null,
      llmModel: null,
      suggestReplyMinImportance: 7,
      jevApiKey: null,
    })

    const rows = await db.select().from(appSettings)
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(ALICE)
    expect(rows[0].suggestReplyMinImportance).toBe(7)
  })
})

describe('sessions', () => {
  /** A session row, as signing in on a device would leave it. */
  async function addSession(
    user: string,
    id: string,
    opts: { expiresAt?: Date; revokedAt?: Date | null } = {},
  ) {
    await db.insert(sessions).values({
      id,
      userId: user,
      tokenHash: 'f'.repeat(64),
      userAgent: `agent-${id}`,
      lastSeenAt: new Date(),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000),
      revokedAt: opts.revokedAt ?? null,
    })
  }

  test('lists a user’s live devices, newest activity first', async () => {
    await registerUser({ email: ALICE, password: PASSWORD })
    await registerUser({ email: BOB, password: PASSWORD })
    await addSession(ALICE, 'laptop')
    await addSession(ALICE, 'phone')
    await addSession(BOB, 'someone-else')

    const devices = await listSessions(ALICE)
    expect(devices.map((d) => d.id).sort()).toEqual(['laptop', 'phone'])
    expect(devices.every((d) => d.userAgent?.startsWith('agent-'))).toBe(true)
  })

  test('leaves out expired rows', async () => {
    await registerUser({ email: ALICE, password: PASSWORD })
    await addSession(ALICE, 'stale', {
      expiresAt: new Date(Date.now() - 1000),
    })
    await addSession(ALICE, 'live')

    expect((await listSessions(ALICE)).map((d) => d.id)).toEqual(['live'])
  })

  test('signing out everywhere else keeps the device asking', async () => {
    await registerUser({ email: ALICE, password: PASSWORD })
    await addSession(ALICE, 'laptop')
    await addSession(ALICE, 'phone')
    await addSession(ALICE, 'tablet')

    await revokeAllSessions(ALICE, 'laptop')

    expect((await listSessions(ALICE)).map((d) => d.id)).toEqual(['laptop'])
    // Deleting the row is the revocation: nothing is left to authenticate with.
    const remaining = await db.select().from(sessions)
    expect(remaining.map((row) => row.id)).toEqual(['laptop'])
  })

  test('signing out everywhere takes the device asking with it', async () => {
    await registerUser({ email: ALICE, password: PASSWORD })
    await addSession(ALICE, 'laptop')
    await addSession(ALICE, 'phone')

    await revokeAllSessions(ALICE)

    expect(await listSessions(ALICE)).toEqual([])
  })

  test('one user revoking their devices leaves another’s alone', async () => {
    await registerUser({ email: ALICE, password: PASSWORD })
    await registerUser({ email: BOB, password: PASSWORD })
    await addSession(ALICE, 'alice-laptop')
    await addSession(BOB, 'bob-phone')

    await revokeAllSessions(ALICE, undefined)

    expect((await listSessions(BOB)).map((d) => d.id)).toEqual(['bob-phone'])
  })
})
