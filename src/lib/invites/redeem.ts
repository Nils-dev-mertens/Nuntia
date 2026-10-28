/**
 * Redeeming an invite.
 *
 * The whole security story of the beta is in this file, and it is deliberately
 * boring:
 *
 * 1. A code is looked up by hash, and every failure — unknown, expired,
 *    revoked, exhausted, wrong address — produces the *same* sentence. A
 *    distinct message per failure would turn `/join` into an oracle for
 *    guessing codes and would tell a terminated tester that they were
 *    terminated.
 * 2. Single use is one conditional `UPDATE`, not a read followed by a write.
 *    Two clicks on the same link must produce one user, and the database is the
 *    only place that can decide which click wins.
 * 3. A code bound to an address is reusable *by that address* without consuming
 *    a use. That is the recovery path for a cleared cookie, and the reason the
 *    approval email keeps working for its two weeks.
 *
 * Sessions are started by the route, not here: `createSession` writes a cookie,
 * and a cookie needs a request. Keeping that out means this module can be
 * tested end to end without a dev server.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'

import { and, eq, isNull, or, gt, sql } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { accessRequests, inviteRedemptions, invites } from '#/db/schema.ts'
import { countUsers, createInvitedUser } from '#/lib/auth/users.ts'

import { normaliseCode } from './codes.ts'
import { findInviteByCode } from './repository.ts'

/** The one sentence every refusal returns. */
export const INVITE_REFUSAL = 'This invite is not valid.'

const FAILURE_WINDOW_MS = 15 * 60_000
const MAX_FAILURES = 8

/**
 * Failed attempts for the whole process.
 *
 * In memory on purpose, like the sign-in counter: one Bun process, and the
 * protection is against a script walking the code space, not against a
 * distributed attacker. Restarting clears it, which loses nothing.
 */
let failures: { count: number; resetAt: number } = { count: 0, resetAt: 0 }

function throttled(): boolean {
  if (failures.resetAt <= Date.now()) return false
  return failures.count >= MAX_FAILURES
}

function noteFailure(): void {
  const now = Date.now()
  if (failures.resetAt <= now) {
    failures = { count: 1, resetAt: now + FAILURE_WINDOW_MS }
    return
  }
  failures.count += 1
}

/** Test hook: each case starts from a clean window. */
export function resetInviteThrottle(): void {
  failures = { count: 0, resetAt: 0 }
}

export type RedeemInput = {
  code: string
  email: string
  name?: string | null
  /**
   * The password chosen on the invite form. It is stored on the account so that
   * signing in later does not depend on finding the original email again.
   * Optional only for callers that redeem a bare code.
   */
  password?: string | null
  /** Browser hint for the redemption row; never used for authorisation. */
  userAgent?: string | null
}

export type RedeemResult =
  | {
      ok: true
      userId: string
      /** `bootstrap` when the code came from the environment, not a row. */
      inviteId: string
      created: boolean
    }
  | { ok: false; error: string }

function refusal(): RedeemResult {
  noteFailure()
  return { ok: false, error: INVITE_REFUSAL }
}

/**
 * The code that starts an otherwise empty install.
 *
 * Without it nobody can open `/admin` on a fresh deployment, because nobody has
 * been invited yet. Honoured only while no user exists, and compared the same
 * way as a stored code — a bootstrap credential that kept working after the
 * first user would be a permanent skeleton key.
 */
export async function matchesBootstrapCode(code: string): Promise<boolean> {
  const configured = process.env.LUMEN_BOOTSTRAP_INVITE?.trim()
  if (!configured) return false
  if ((await countUsers()) > 0) return false

  const submitted = Buffer.from(normaliseCode(code) ?? '')
  const expected = Buffer.from(normaliseCode(configured) ?? '')
  if (submitted.length === 0 || submitted.length !== expected.length)
    return false

  return timingSafeEqual(submitted, expected)
}

export async function redeemInvite(input: RedeemInput): Promise<RedeemResult> {
  if (throttled()) return refusal()

  const invite = await findInviteByCode(input.code)

  if (!invite) {
    if (!(await matchesBootstrapCode(input.code))) return refusal()

    const created = await createInvitedUser({
      email: input.email,
      name: input.name ?? null,
      password: input.password ?? null,
    })
    if ('error' in created) return { ok: false, error: created.error }

    failures = { count: 0, resetAt: 0 }
    return {
      ok: true,
      userId: created.user.id,
      inviteId: 'bootstrap',
      created: created.created,
    }
  }

  const now = new Date()
  if (invite.revokedAt) return refusal()
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) {
    return refusal()
  }

  const email = input.email.trim().toLowerCase()
  const boundTo = invite.email?.trim().toLowerCase() ?? null

  // A bound invite is for one address. Anybody else holding the link is
  // refused with the same sentence as a bad code, so a forwarded link does not
  // confirm that it would have worked.
  if (boundTo && boundTo !== email) return refusal()

  const reusable = Boolean(boundTo)

  if (!reusable) {
    // The single-use guard. Everything that can be checked without writing has
    // been checked above; this is the only statement that must be atomic.
    const reserved = await db
      .update(invites)
      .set({ useCount: sql`${invites.useCount} + 1` })
      .where(
        and(
          eq(invites.id, invite.id),
          sql`${invites.useCount} < ${invites.maxUses}`,
          isNull(invites.revokedAt),
          or(isNull(invites.expiresAt), gt(invites.expiresAt, new Date())),
        ),
      )

    if (reserved.rowsAffected === 0) return refusal()
  }

  const created = await createInvitedUser({
    email,
    name: input.name ?? null,
    password: input.password ?? null,
  })

  if ('error' in created) {
    // Give the use back. The failure is about the form, not about the invite,
    // and burning a use would make a typo look like an exhausted link.
    if (!reusable) {
      await db
        .update(invites)
        .set({ useCount: sql`${invites.useCount} - 1` })
        .where(eq(invites.id, invite.id))
    }
    return { ok: false, error: created.error }
  }

  const userId = created.user.id

  // Re-redeeming a bound invite signs the same person back in. Recording a
  // second redemption would inflate the funnel, so the row is the pair.
  const already = await db.query.inviteRedemptions.findFirst({
    where: and(
      eq(inviteRedemptions.inviteId, invite.id),
      eq(inviteRedemptions.userId, userId),
    ),
  })

  if (!already) {
    await db
      .insert(inviteRedemptions)
      .values({
        id: randomUUID(),
        inviteId: invite.id,
        userId,
        userAgent: input.userAgent ?? null,
      })
      .onConflictDoNothing()
  }

  // The request that produced this invite moves to `redeemed` here rather than
  // at approval, so "how many approvals became users" is a fact about a person
  // rather than a guess about a link.
  await db
    .update(accessRequests)
    .set({ status: 'redeemed' })
    .where(
      and(
        eq(accessRequests.inviteId, invite.id),
        eq(accessRequests.status, 'approved'),
      ),
    )

  failures = { count: 0, resetAt: 0 }

  return {
    ok: true,
    userId,
    inviteId: invite.id,
    created: created.created,
  }
}
