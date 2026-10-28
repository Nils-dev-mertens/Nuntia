/**
 * People who sign in to this install.
 *
 * Authorisation stops here: a user owns mailboxes, and every mailbox query is
 * scoped by the signed-in user id. Passwords are standard argon2id hashes
 * (PHC string format) from `hash-wasm` — a WASM implementation rather than
 * `Bun.password`, because the dev server runs SSR modules in a Node `vm`
 * context where the `Bun` global does not exist. The encoded format is
 * identical, so hashes written by either implementation verify with the other.
 * The verify path is constant-time enough that a wrong password and an
 * unknown address take the same shape.
 *
 * Bootstrap rules, in order:
 *
 * 1. If `LUMEN_DEFAULT_USER_EMAIL` / `LUMEN_DEFAULT_USER_PASSWORD` are set and
 *    there are no users yet, that account is created on the first request — in
 *    either access mode, as the admin.
 * 2. Otherwise the first sign-up adopts any mailboxes written before accounts
 *    existed (`user_id IS NULL`), so an existing install is not stranded.
 *
 * After that, who may create an account is `access.ts`'s decision: the beta takes
 * an invite, `login` mode takes the open form. Signing in with a password works
 * either way, and nobody sees anyone else's mail.
 */

import { randomBytes } from 'node:crypto'

import { count, eq, isNull } from 'drizzle-orm'
import { argon2id, argon2Verify } from 'hash-wasm'

import { db } from '#/db/index.ts'
import { accounts, appSettings, users } from '#/db/schema.ts'
import type { User } from '#/db/schema.ts'

import { invitesOnly } from './access.ts'

/** What the UI and session payload may see. Never the hash. */
export type PublicUser = {
  id: string
  email: string
  name: string | null
  createdAt: Date
}

const MIN_PASSWORD_LENGTH = 10
const MAX_PASSWORD_LENGTH = 200
const MAX_EMAIL_LENGTH = 254
const MAX_NAME_LENGTH = 100

/** Deliberately loose: it rejects obvious junk without pretending to be RFC 5322. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * One sentence per way a password can be unacceptable.
 *
 * Shared by sign-up, invite redemption and the set-password script so the three
 * cannot drift into telling the same person different rules.
 */
function passwordProblem(password: string | null | undefined): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return 'That password is too long.'
  }
  return null
}

/**
 * Failed sign-in throttle, per email address.
 *
 * In memory on purpose: this is one Bun process, the protection is against a
 * password-guessing loop, and a restart clearing it is not a meaningful loss.
 * A distributed deployment would move this to the database or a shared cache.
 */
const FAILURE_WINDOW_MS = 15 * 60_000
const MAX_FAILURES = 8
const failures = new Map<string, { count: number; resetAt: number }>()

function tooManyFailures(email: string): boolean {
  const entry = failures.get(email)
  if (!entry) return false
  if (entry.resetAt <= Date.now()) {
    failures.delete(email)
    return false
  }
  return entry.count >= MAX_FAILURES
}

function noteFailure(email: string): void {
  const now = Date.now()
  const entry = failures.get(email)
  if (!entry || entry.resetAt <= now) {
    failures.set(email, { count: 1, resetAt: now + FAILURE_WINDOW_MS })
    return
  }
  entry.count += 1
}

function clearFailures(email: string): void {
  failures.delete(email)
}

/**
 * argon2id parameters.
 *
 * The same values `Bun.password` used, so hashes written before this moved to
 * `hash-wasm` keep verifying and remain indistinguishable from new ones.
 */
const ARGON2_OPTIONS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 65_536, // KiB, i.e. 64 MiB
  hashLength: 32,
} as const

const SALT_BYTES = 16

/** Hash a password as an argon2id PHC string, salt included. */
async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(SALT_BYTES),
    ...ARGON2_OPTIONS,
    outputType: 'encoded',
  })
}

/**
 * Verify against a stored PHC string.
 *
 * A malformed or truncated hash is a failed password, not a 500: an unreadable
 * row should not take down the sign-in page or reveal that it is unreadable.
 */
async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash })
  } catch {
    return false
  }
}

/** Lazily built argon2 hash, so an unknown address costs a verify too. */
let dummyHash: Promise<string> | null = null

async function verifyAgainstDummy(password: string): Promise<boolean> {
  dummyHash ??= hashPassword('nuntia-dummy-password')
  return verifyPassword(password, await dummyHash)
}

function toPublic(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
  }
}

export async function countUsers(): Promise<number> {
  // Destructured directly: the driver types a `select` result as a tuple, so the
  // row is not optional and a fallback would only hide a broken query.
  const [{ value }] = await db.select({ value: count() }).from(users)
  return value
}

export async function getUser(id: string): Promise<PublicUser | null> {
  const row = await db.query.users.findFirst({
    where: eq(users.id, id.toLowerCase()),
  })
  return row ? toPublic(row) : null
}

/**
 * Move pre-account rows onto the first user.
 *
 * Only ever called when the user table was empty, so there is exactly one
 * candidate owner for a mailbox that predates sign-in.
 */
async function adoptOrphans(userId: string): Promise<void> {
  await db.update(accounts).set({ userId }).where(isNull(accounts.userId))

  await db.update(appSettings).set({ userId }).where(isNull(appSettings.userId))
}

export type RegisterInput = {
  email: string
  password: string
  name?: string | null
}

/** Create a user. Returns a sentence the form can show instead of throwing. */
export async function registerUser(
  input: RegisterInput,
): Promise<{ user: PublicUser } | { error: string }> {
  // The route already redirects, but the server function is its own endpoint.
  if (invitesOnly()) {
    return { error: 'Registration is invite-only right now.' }
  }

  const email = input.email.trim().toLowerCase()

  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return { error: 'Enter a valid email address.' }
  }
  const problem = passwordProblem(input.password)
  if (problem) return { error: problem }

  const name = input.name?.trim() || null
  if (name && name.length > MAX_NAME_LENGTH) {
    return { error: 'That name is too long.' }
  }

  const existing = await db.query.users.findFirst({
    where: eq(users.id, email),
  })
  if (existing) return { error: 'That email is already registered.' }

  const isFirst = (await countUsers()) === 0

  try {
    const passwordHash = await hashPassword(input.password)

    await db.insert(users).values({ id: email, email, name, passwordHash })

    if (isFirst) await adoptOrphans(email)

    return {
      user: {
        id: email,
        email,
        name,
        createdAt: new Date(),
      },
    }
  } catch (error) {
    console.error('[auth] could not create the user:', error)

    // A unique-constraint race between two sign-ups is the one expected
    // failure. Anything else is ours, and saying "already registered" for it
    // hides the real cause from the person signing up and from the logs.
    if (
      error instanceof Error &&
      /UNIQUE constraint failed/i.test(error.message)
    ) {
      return { error: 'That email is already registered.' }
    }

    return { error: 'Could not create the account. Try again.' }
  }
}

/**
 * Create (or find) the person an invite belongs to.
 *
 * The invite form asks for a password, and this stores it: redemption is
 * registration, and an account nobody can sign in to again is a support problem
 * the moment the session cookie is gone. The password is optional only so the
 * bare-code paths keep working (the environment bootstrap code, the tests, a
 * script): without one, `password_hash` — `NOT NULL` — gets a hash of 32 random
 * bytes that nothing can match.
 *
 * An existing address returns its user instead of failing: an address-bound
 * invite is also the way back in after a cleared cookie, and "already
 * registered" would make that recovery impossible. A password submitted on that
 * second visit replaces the stored hash, which is what makes the same link a
 * "set my password" path for an account created before this form asked for one.
 *
 * The first person on an empty install becomes the admin. That is the only way
 * `/admin` can exist before an operator does — otherwise nobody could approve
 * the next request, and the beta would need a manual SQL insert to start.
 */
export async function createInvitedUser(input: {
  email: string
  name?: string | null
  /** Absent only on the code-only paths; the invite form always sends one. */
  password?: string | null
}): Promise<{ user: PublicUser; created: boolean } | { error: string }> {
  const email = input.email.trim().toLowerCase()

  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return { error: 'Enter a valid email address.' }
  }

  const name = input.name?.trim() || null
  if (name && name.length > MAX_NAME_LENGTH) {
    return { error: 'That name is too long.' }
  }

  const password = input.password ?? null
  if (password !== null) {
    const problem = passwordProblem(password)
    if (problem) return { error: problem }
  }

  const existing = await db.query.users.findFirst({
    where: eq(users.id, email),
  })
  if (existing) {
    // Presented with the link for their own address, the person may set (or
    // replace) the password. Possession of a bound invite already signs this
    // address in, so resetting the hash grants nothing the link did not.
    if (password !== null) {
      const passwordHash = await hashPassword(password)
      await db.update(users).set({ passwordHash }).where(eq(users.id, email))
    }

    return { user: toPublic(existing), created: false }
  }

  const isFirst = (await countUsers()) === 0

  try {
    const passwordHash = await hashPassword(
      password ?? randomBytes(32).toString('base64'),
    )

    await db.insert(users).values({
      id: email,
      email,
      name,
      passwordHash,
      role: isFirst ? 'admin' : 'member',
    })

    if (isFirst) await adoptOrphans(email)

    return {
      user: { id: email, email, name, createdAt: new Date() },
      created: true,
    }
  } catch (error) {
    // Two redemptions of the same address-bound invite can race here. The row
    // is the identity, so the loser signs in rather than seeing an error.
    if (
      error instanceof Error &&
      /UNIQUE constraint failed/i.test(error.message)
    ) {
      const row = await db.query.users.findFirst({
        where: eq(users.id, email),
      })
      if (row) return { user: toPublic(row), created: false }
    }

    console.error('[auth] could not create the invited user:', error)
    return { error: 'Could not create the account. Try again.' }
  }
}

/**
 * Set the password of an account, creating it when it does not exist.
 *
 * The way in for anyone who got in before the invite form asked for a password,
 * and for an install whose account was never created at all — the case that
 * matters most, because with no user there is nothing to sign in as and no
 * invite can be issued either. Creating is part of the job for the same reason
 * as setting: whoever holds the shell is the only party who can prove an address
 * with neither a password nor a mailbox.
 *
 * A reset of an existing account goes through `createInvitedUser`, so the rules
 * (password length, first user becomes admin) are the same ones redemption uses.
 */
export async function setUserPassword(
  email: string,
  password: string,
  options: { admin?: boolean } = {},
): Promise<{ user: PublicUser; created: boolean } | { error: string }> {
  const id = email.trim().toLowerCase()
  if (!id) return { error: 'Enter the address of the account.' }

  const problem = passwordProblem(password)
  if (problem) return { error: problem }

  const result = await createInvitedUser({ email: id, password })
  if ('error' in result) return result

  // Asked for explicitly, because an install that already has users makes this
  // one a member — and the person running the command is usually the operator.
  if (options.admin) {
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, id))
  }

  return result
}

/**
 * Check a password.
 *
 * The failure is one sentence for both "no such user" and "wrong password", so
 * the form cannot be used to enumerate addresses.
 */
export async function authenticateUser(
  email: string,
  password: string,
): Promise<{ user: PublicUser } | { error: string }> {
  const id = email.trim().toLowerCase()

  if (!id || typeof password !== 'string' || password.length === 0) {
    return { error: 'Enter your email and password.' }
  }

  if (tooManyFailures(id)) {
    return { error: 'Too many attempts. Try again in a few minutes.' }
  }

  const row = await db.query.users.findFirst({ where: eq(users.id, id) })
  const ok = row
    ? await verifyPassword(password, row.passwordHash)
    : await verifyAgainstDummy(password)

  if (!ok || !row) {
    noteFailure(id)
    return { error: 'Email or password is incorrect.' }
  }

  clearFailures(id)
  return { user: toPublic(row) }
}

let bootstrap: Promise<void> | null = null

/**
 * Create the configured first user, once.
 *
 * Safe to call on every request: after the first attempt the resolved promise is
 * reused, and failures are logged and retried on the next boot of the process
 * rather than turning every page into a 500.
 */
export function ensureBootstrapUser(): Promise<void> {
  bootstrap ??= bootstrapDefaultUser().catch((error) => {
    console.error('[auth] bootstrap user failed:', error)
    bootstrap = null
  })
  return bootstrap
}

/**
 * The body of the bootstrap, without the memoisation.
 *
 * Exported so a test can drive it more than once in a process — every check in
 * it is a query, so running it again is cheap and has no side effect beyond the
 * first. Production always goes through `ensureBootstrapUser`.
 */
export async function bootstrapDefaultUser(): Promise<void> {
  // Honoured in both access modes. These variables are set by whoever runs the
  // machine, so the account they describe is one somebody explicitly asked for —
  // the opposite of registering through the open form, which is the only thing
  // invite mode closes. Gating it on `login` meant a beta deployment configured
  // this way came up with no account at all, and its operator had no way in to
  // approve the first request either.
  const email = process.env.LUMEN_DEFAULT_USER_EMAIL?.trim().toLowerCase()
  const password = process.env.LUMEN_DEFAULT_USER_PASSWORD

  if (!email || !password) return

  if (!EMAIL_RE.test(email) || password.length < MIN_PASSWORD_LENGTH) {
    console.warn(
      '[auth] LUMEN_DEFAULT_USER_EMAIL / LUMEN_DEFAULT_USER_PASSWORD are set but invalid; ignoring them.',
    )
    return
  }

  // Only the *first* user comes from the environment. Once anyone has signed up,
  // the variable must not silently recreate an account or adopt their mail.
  if ((await countUsers()) > 0) return

  const passwordHash = await hashPassword(password)

  // `admin` for the same reason `createInvitedUser` promotes the first person:
  // without it, a freshly bootstrapped install has no way into `/admin`.
  await db
    .insert(users)
    .values({ id: email, email, passwordHash, role: 'admin' })
  await adoptOrphans(email)
  console.info(`[auth] created the default admin ${email}`)
}
