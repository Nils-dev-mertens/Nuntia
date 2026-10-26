/**
 * People asking to get in.
 *
 * The form is the only page a stranger can reach, so it has three jobs: collect
 * the sentence that explains why they want access, refuse to become an account
 * oracle, and not turn into an inbox to file.
 *
 * The answer is the same for every outcome — a new address, one that is already
 * pending, one that already has an account, one declined last week. Any
 * difference would let the page confirm who is registered here, which is worth
 * more to an attacker than the sentence is to a person.
 *
 * Approval is two writes and a send: create the invite, point the request at
 * it, then mail the link. The mail is allowed to fail without undoing the
 * decision — see `notify.ts`.
 */

import { randomUUID } from 'node:crypto'

import { getRequestHeader } from '@tanstack/react-start/server'
import { desc, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { accessRequests } from '#/db/schema.ts'

import { createInvite } from './repository.ts'
import type { CreatedInvite } from './repository.ts'
import { notifyInvite } from './notify.ts'
import type { NotifyResult } from './notify.ts'

const MAX_EMAIL_LENGTH = 254
const MAX_NAME_LENGTH = 100
const MAX_NOTE_LENGTH = 2_000
const MAX_SOURCE_LENGTH = 200

/** Deliberately loose, and the same rule the auth layer uses. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const WINDOW_MS = 60 * 60_000
const MAX_PER_WINDOW = 5

type Bucket = { count: number; resetAt: number }

/**
 * Submissions per IP, per hour.
 *
 * In memory because this is one process. It is aimed at scripts, not people: a
 * beta request form will never see five honest submissions from one address in
 * an hour.
 */
const buckets = new Map<string, Bucket>()

function clientIp(): string {
  try {
    const forwarded = getRequestHeader('x-forwarded-for')
    const first = forwarded?.split(',')[0]?.trim()
    return first || getRequestHeader('x-real-ip')?.trim() || 'local'
  } catch {
    // No request context (tests, scripts): one bucket, which is fine.
    return 'local'
  }
}

function overBudget(ip: string): boolean {
  const bucket = buckets.get(ip)
  if (!bucket) return false
  if (bucket.resetAt <= Date.now()) {
    buckets.delete(ip)
    return false
  }
  return bucket.count >= MAX_PER_WINDOW
}

function spend(ip: string): void {
  const now = Date.now()
  const bucket = buckets.get(ip)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return
  }
  bucket.count += 1
}

/** Test hook. */
export function resetRequestThrottle(): void {
  buckets.clear()
}

export type SubmitRequestInput = {
  email: string
  name?: string | null
  note: string
  source?: string | null
  /**
   * A field hidden from people with CSS. Anything in it means a form-filling
   * script, and the submission is dropped with the normal answer.
   */
  honeypot?: string | null
}

/**
 * What the route shows is deliberately not returned from here: this module
 * imports server-only helpers, and a string a component renders would drag the
 * whole file into the client bundle — which is exactly how `node:crypto` ends
 * up externalised in the browser.
 */
export type SubmitRequestResult =
  | { ok: true }
  | { ok: false; error: string }

export async function submitRequest(
  input: SubmitRequestInput,
): Promise<SubmitRequestResult> {
  if (input.honeypot?.trim()) return { ok: true }

  const ip = clientIp()
  if (overBudget(ip)) {
    // Refused as a normal success: a script learns nothing, and a person who
    // really did submit five times already has their answer on screen.
    return { ok: true }
  }

  const email = input.email.trim().toLowerCase()
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return { ok: false, error: 'Enter a valid email address.' }
  }

  const note = input.note.trim()
  if (note.length < 3) {
    return { ok: false, error: 'Tell us what you are trying to fix.' }
  }
  if (note.length > MAX_NOTE_LENGTH) {
    return { ok: false, error: 'That is a little too long — keep it shorter.' }
  }

  const name = input.name?.trim() || null
  if (name && name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: 'That name is too long.' }
  }

  const source = input.source?.trim() || null
  if (source && source.length > MAX_SOURCE_LENGTH) {
    return { ok: false, error: 'That is too long for one line.' }
  }

  spend(ip)

  // One pending request per address, enforced by the partial unique index.
  // Checking first keeps the common repeat from hitting a constraint error.
  const pending = await db.query.accessRequests.findFirst({
    where: eq(accessRequests.email, email),
    orderBy: desc(accessRequests.createdAt),
  })
  if (pending?.status === 'pending') {
    return { ok: true }
  }

  try {
    await db.insert(accessRequests).values({
      id: randomUUID(),
      email,
      name,
      note,
      source,
    })
  } catch (error) {
    // A double submit racing the index is the only expected failure, and it
    // means exactly what the visitor is already being told.
    if (
      !(error instanceof Error) ||
      !/UNIQUE constraint failed/i.test(error.message)
    ) {
      console.error('[invites] could not store the request:', error)
      return { ok: false, error: 'Could not send that. Try again in a moment.' }
    }
  }

  return { ok: true }
}

export type RequestRow = {
  id: string
  email: string
  name: string | null
  note: string
  source: string | null
  status: (typeof accessRequests.$inferSelect)['status']
  inviteId: string | null
  declinedReason: string | null
  createdAt: Date
  decidedAt: Date | null
}

/** Newest first; the pending queue and the history in one list. */
export async function listRequests(): Promise<RequestRow[]> {
  return db.query.accessRequests.findMany({
    orderBy: (table, { desc: descending }) => [descending(table.createdAt)],
  })
}

export type ApproveResult =
  | {
      ok: true
      invite: CreatedInvite
      notify: NotifyResult
    }
  | { ok: false; error: string }

/**
 * Approve a pending request: issue the invite, link it, then send.
 *
 * The request is marked approved before the send is attempted, so a mail
 * failure leaves a decision the operator can retry rather than a pending row
 * that looks like nothing happened.
 */
export async function approveRequest(
  requestId: string,
  operatorId: string,
): Promise<ApproveResult> {
  const request = await db.query.accessRequests.findFirst({
    where: eq(accessRequests.id, requestId),
  })

  if (!request) return { ok: false, error: 'That request no longer exists.' }
  if (request.status !== 'pending') {
    return { ok: false, error: 'That request has already been decided.' }
  }

  const invite = await createInvite({
    email: request.email,
    label: request.name ?? request.email,
    createdBy: operatorId,
  })

  await db
    .update(accessRequests)
    .set({
      status: 'approved',
      inviteId: invite.id,
      decidedAt: new Date(),
      decidedBy: operatorId.toLowerCase(),
      declinedReason: null,
    })
    .where(eq(accessRequests.id, requestId))

  const notify = await notifyInvite({
    inviteId: invite.id,
    code: invite.code,
    to: request.email,
    operatorId,
  })

  return { ok: true, invite, notify }
}

/** Decline a pending request. The requester is not told. */
export async function declineRequest(
  requestId: string,
  operatorId: string,
  reason: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const request = await db.query.accessRequests.findFirst({
    where: eq(accessRequests.id, requestId),
  })

  if (!request) return { ok: false, error: 'That request no longer exists.' }
  if (request.status !== 'pending') {
    return { ok: false, error: 'That request has already been decided.' }
  }

  await db
    .update(accessRequests)
    .set({
      status: 'declined',
      declinedReason: reason?.trim().slice(0, 500) || null,
      decidedAt: new Date(),
      decidedBy: operatorId.toLowerCase(),
    })
    .where(eq(accessRequests.id, requestId))

  return { ok: true }
}
