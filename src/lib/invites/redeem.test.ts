/**
 * Redeeming an invite.
 *
 * Every case here is a line that must not be crossed: a dead code must not
 * create a user, a single-use code must not create two, a bound code must not
 * admit a different address, and every refusal must read the same. The tests
 * assert the sentence as well as the outcome, because the sentence *is* the
 * security property — a distinct message per failure is an oracle.
 *
 * Sessions are not part of this module: `createSession` writes a cookie and
 * needs a request. The route starts the session once redemption has returned a
 * user id, which is what keeps this testable without a dev server.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

// A database of its own, before any module reads DATABASE_URL.
const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-invites-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const {
  accessRequests,
  accounts,
  feedback,
  inviteRedemptions,
  invites,
  sessions,
  users,
} = await import('#/db/schema.ts')
const { authenticateUser, createInvitedUser, setUserPassword } =
  await import('#/lib/auth/users.ts')
const { createInvite } = await import('#/lib/invites/repository.ts')
const { INVITE_REFUSAL, redeemInvite, resetInviteThrottle } =
  await import('#/lib/invites/redeem.ts')
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
  await db.delete(inviteRedemptions)
  await db.delete(accessRequests)
  await db.delete(invites)
  await db.delete(feedback)
  await db.delete(sessions)
  await db.delete(accounts)
  await db.delete(users)
  resetInviteThrottle()
  delete process.env.LUMEN_BOOTSTRAP_INVITE
})

describe('redeemInvite', () => {
  test('creates the user, records the redemption, and reports success', async () => {
    const invite = await createInvite({ label: 'Ada' })

    const result = await redeemInvite({
      code: invite.code,
      email: ALICE,
      name: 'Ada',
      userAgent: 'test-agent',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.created).toBe(true)

    const user = await db.query.users.findFirst({
      where: eq(users.id, ALICE),
    })
    expect(user?.email).toBe(ALICE)
    expect(user?.name).toBe('Ada')
    // A password hash exists because the column is NOT NULL, and it is a real
    // argon2id hash of random bytes — not a sentinel anything could match.
    expect(user?.passwordHash.startsWith('$argon2id$')).toBe(true)

    const redemption = await db.query.inviteRedemptions.findFirst({
      where: eq(inviteRedemptions.inviteId, invite.id),
    })
    expect(redemption?.userId).toBe(ALICE)
    expect(redemption?.userAgent).toBe('test-agent')
  })

  test('a single-use code creates exactly one user', async () => {
    const invite = await createInvite()

    const first = await redeemInvite({ code: invite.code, email: ALICE })
    const second = await redeemInvite({ code: invite.code, email: BOB })

    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, error: INVITE_REFUSAL })
  })

  test('is case- and separator-insensitive on the code', async () => {
    const invite = await createInvite()
    const typed = invite.code.toLowerCase().replace(/-/g, ' ')

    const result = await redeemInvite({ code: typed, email: ALICE })
    expect(result.ok).toBe(true)
  })

  test('refuses an unknown code with the shared sentence', async () => {
    const result = await redeemInvite({
      code: 'ZZZZ-ZZZZ-ZZZZ',
      email: ALICE,
    })

    expect(result).toEqual({ ok: false, error: INVITE_REFUSAL })
  })

  test('refuses a malformed code without touching the database', async () => {
    const result = await redeemInvite({ code: 'nope', email: ALICE })

    expect(result).toEqual({ ok: false, error: INVITE_REFUSAL })
    expect(await db.query.users.findMany()).toHaveLength(0)
  })

  test('refuses an expired invite', async () => {
    const invite = await createInvite({
      expiresAt: new Date(Date.now() - 1_000),
    })

    const result = await redeemInvite({ code: invite.code, email: ALICE })
    expect(result).toEqual({ ok: false, error: INVITE_REFUSAL })
  })

  test('refuses a revoked invite exactly like an unknown one', async () => {
    const invite = await createInvite()
    await db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(eq(invites.id, invite.id))

    const result = await redeemInvite({ code: invite.code, email: ALICE })
    expect(result).toEqual({ ok: false, error: INVITE_REFUSAL })
  })

  test('an address-bound invite admits only that address', async () => {
    const invite = await createInvite({ email: ALICE })

    // The case the binding exists for: the link was forwarded.
    const stranger = await redeemInvite({ code: invite.code, email: BOB })
    expect(stranger).toEqual({ ok: false, error: INVITE_REFUSAL })

    const owner = await redeemInvite({ code: invite.code, email: ALICE })
    expect(owner.ok).toBe(true)
  })

  test('an address-bound invite still works the second time, without a new row', async () => {
    const invite = await createInvite({ email: ALICE })

    const first = await redeemInvite({ code: invite.code, email: ALICE })
    const again = await redeemInvite({ code: invite.code, email: ALICE })

    expect(first.ok).toBe(true)
    expect(again.ok).toBe(true)
    if (!first.ok || !again.ok) return
    // Signing back in is not a second signup: the funnel must not inflate.
    expect(again.userId).toBe(first.userId)
    expect(again.created).toBe(false)

    const redemptions = await db.query.inviteRedemptions.findMany()
    expect(redemptions).toHaveLength(1)
  })

  test('stores the password chosen on the invite form, so a later visit can sign in', async () => {
    const invite = await createInvite({ email: ALICE })

    const result = await redeemInvite({
      code: invite.code,
      email: ALICE,
      password: 'a-proper-password',
    })
    expect(result.ok).toBe(true)

    // The point of the password: signing in must not need the invite email.
    const signedIn = await authenticateUser(ALICE, 'a-proper-password')
    expect('user' in signedIn).toBe(true)

    const wrong = await authenticateUser(ALICE, 'something-else-entirely')
    expect('error' in wrong).toBe(true)
  })

  test('re-redeeming a bound invite replaces the password', async () => {
    const invite = await createInvite({ email: ALICE })

    await redeemInvite({
      code: invite.code,
      email: ALICE,
      password: 'the-first-password',
    })
    const again = await redeemInvite({
      code: invite.code,
      email: ALICE,
      password: 'the-second-password',
    })
    expect(again.ok).toBe(true)

    expect(
      'user' in (await authenticateUser(ALICE, 'the-second-password')),
    ).toBe(true)
    expect(
      'error' in (await authenticateUser(ALICE, 'the-first-password')),
    ).toBe(true)
  })

  test('a too-short password is a form error, and the invite is not spent', async () => {
    const invite = await createInvite()

    const result = await redeemInvite({
      code: invite.code,
      email: ALICE,
      password: 'short',
    })
    expect(result).toEqual({
      ok: false,
      error: 'Use a password of at least 10 characters.',
    })

    const usersAfter = await db.query.users.findMany()
    expect(usersAfter).toHaveLength(0)

    const retry = await redeemInvite({
      code: invite.code,
      email: ALICE,
      password: 'a-proper-password',
    })
    expect(retry.ok).toBe(true)
  })

  test('the bootstrap code also carries a password', async () => {
    process.env.LUMEN_BOOTSTRAP_INVITE = 'AAAA-BBBB-CCCC'

    const result = await redeemInvite({
      code: 'AAAA-BBBB-CCCC',
      email: ALICE,
      password: 'first-admin-password',
    })
    expect(result.ok).toBe(true)
    expect(
      'user' in (await authenticateUser(ALICE, 'first-admin-password')),
    ).toBe(true)

    delete process.env.LUMEN_BOOTSTRAP_INVITE
  })

  test('the operator script sets a password on an account that has none', async () => {
    // An invite redeemed without a password is how every account made before
    // the form asked for one looks: a hash nothing can match.
    await createInvitedUser({ email: ALICE })
    expect('error' in (await authenticateUser(ALICE, 'anything-at-all'))).toBe(
      true,
    )

    const set = await setUserPassword(ALICE, 'the-operator-set-this')
    expect('user' in set).toBe(true)
    expect(
      'user' in (await authenticateUser(ALICE, 'the-operator-set-this')),
    ).toBe(true)

    const missing = await setUserPassword(BOB, 'the-operator-set-this')
    expect(missing).toEqual({ error: `No account for ${BOB}.` })
  })

  test('the first person on the install is the admin, the next is a member', async () => {
    const firstInvite = await createInvite()
    const secondInvite = await createInvite()

    await redeemInvite({ code: firstInvite.code, email: ALICE })
    await redeemInvite({ code: secondInvite.code, email: BOB })

    const alice = await db.query.users.findFirst({ where: eq(users.id, ALICE) })
    const bob = await db.query.users.findFirst({ where: eq(users.id, BOB) })

    expect(alice?.role).toBe('admin')
    expect(bob?.role).toBe('member')
  })

  test('marks the request that produced the invite as redeemed', async () => {
    const invite = await createInvite({ email: ALICE })
    await db.insert(accessRequests).values({
      id: 'request-1',
      email: ALICE,
      name: 'Ada',
      note: 'Inbox zero is a lie.',
      status: 'approved',
      inviteId: invite.id,
    })

    await redeemInvite({ code: invite.code, email: ALICE })

    const request = await db.query.accessRequests.findFirst({
      where: eq(accessRequests.id, 'request-1'),
    })
    expect(request?.status).toBe('redeemed')
  })

  test('a bad form value returns the form error, not the refusal, and gives the use back', async () => {
    const invite = await createInvite()

    const result = await redeemInvite({
      code: invite.code,
      email: 'not-an-email',
    })
    expect(result).toEqual({ ok: false, error: 'Enter a valid email address.' })

    // The invite is still usable: a typo is not a spent link.
    const retry = await redeemInvite({ code: invite.code, email: ALICE })
    expect(retry.ok).toBe(true)
  })

  test('the environment bootstrap code works once, and only on an empty install', async () => {
    process.env.LUMEN_BOOTSTRAP_INVITE = 'AAAA-BBBB-CCCC'

    const first = await redeemInvite({
      code: 'aaaa bbbb cccc',
      email: ALICE,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.inviteId).toBe('bootstrap')

    const alice = await db.query.users.findFirst({ where: eq(users.id, ALICE) })
    expect(alice?.role).toBe('admin')

    // With a user in place the code is dead: a bootstrap credential that kept
    // working would be a permanent way in.
    const second = await redeemInvite({
      code: 'AAAA-BBBB-CCCC',
      email: BOB,
    })
    expect(second).toEqual({ ok: false, error: INVITE_REFUSAL })

    delete process.env.LUMEN_BOOTSTRAP_INVITE
  })

  test('throttles repeated failures, and the throttle answers like a bad code', async () => {
    for (let i = 0; i < 8; i += 1) {
      await redeemInvite({ code: 'ZZZZ-ZZZZ-ZZZZ', email: ALICE })
    }

    const valid = await createInvite()
    // Even a valid code is refused while the window is full — that is what
    // makes the throttle useless as an oracle.
    const result = await redeemInvite({ code: valid.code, email: ALICE })
    expect(result).toEqual({ ok: false, error: INVITE_REFUSAL })

    resetInviteThrottle()
    const after = await redeemInvite({ code: valid.code, email: ALICE })
    expect(after.ok).toBe(true)
  })
})
