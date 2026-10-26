/**
 * Invite persistence.
 *
 * Two stored forms of the same code: a SHA-256 hash for the redemption lookup,
 * and AES-GCM ciphertext so the operator can copy the link again. The hash is
 * the one redemption uses; the ciphertext exists because "what did I send
 * them?" is a normal question and minting a replacement is a poor answer to it.
 *
 * Everything else is bookkeeping for the operator page — how many people
 * redeemed an invite, how many of them actually connected a mailbox — which is
 * cheap to compute at beta scale (tens of rows) and easier to read than a
 * five-way join.
 */

import { randomUUID } from 'node:crypto'

import { desc, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { accounts, invites } from '#/db/schema.ts'
import type { Invite } from '#/db/schema.ts'
import { encrypt, tryDecrypt } from '#/lib/auth/crypto.ts'

import { formatCode, normaliseCode } from './codes.ts'
import { generateCode, hashCode } from './secrets.ts'

/** How long a new invite lasts unless told otherwise. */
export const DEFAULT_EXPIRY_DAYS = 14

const MAX_LABEL_LENGTH = 120
const MAX_USES_LIMIT = 100

export type CreateInviteInput = {
  /** Who it is for. Free text from the operator. */
  label?: string | null
  /** Bound address. Lowercased here; the only address that may redeem it. */
  email?: string | null
  maxUses?: number
  /** Null means no expiry. Undefined takes the 14-day default. */
  expiresAt?: Date | null
  createdBy?: string | null
}

export type CreatedInvite = {
  id: string
  /** The plaintext code. Returned once, and never retrievable again. */
  code: string
  /** Grouped the same way `code` is, for a copy button. */
  formattedCode: string
  email: string | null
  expiresAt: Date | null
}

export type InviteSummary = {
  id: string
  label: string | null
  email: string | null
  maxUses: number
  useCount: number
  expiresAt: Date | null
  revokedAt: Date | null
  notifiedAt: Date | null
  notifyError: string | null
  createdAt: Date
  /** The code, decrypted, when it can still be recovered. */
  code: string | null
  /** Distinct people who redeemed it. */
  redeemed: number
  /** Of those, the ones with at least one connected mailbox. */
  activated: number
}

/**
 * Seal a code for later display.
 *
 * With no encryption key the column stays null: the invite still works, the
 * operator just cannot re-read the link, and `/admin` says so instead of
 * offering a copy that would fail. A *malformed* key is left to throw — that is
 * a configuration error and swallowing it would hide it until someone needed a
 * link.
 */
function sealCode(code: string): string | null {
  if (!process.env.TOKEN_ENCRYPTION_KEY) return null
  return encrypt(code)
}

/**
 * Create an invite, returning the code so it can be sent immediately.
 *
 * A bound address is normalised to lowercase because `users.id` is, and the
 * binding comparison is a string equality — one casing difference would refuse
 * the person it was meant for.
 */
export async function createInvite(
  input: CreateInviteInput = {},
): Promise<CreatedInvite> {
  const label = input.label?.trim() || null
  if (label && label.length > MAX_LABEL_LENGTH) {
    throw new Error(`Keep the label to ${MAX_LABEL_LENGTH} characters.`)
  }

  const email = input.email?.trim().toLowerCase() || null

  const maxUses = input.maxUses ?? 1
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES_LIMIT) {
    throw new Error(`Use a whole number of uses between 1 and ${MAX_USES_LIMIT}.`)
  }

  const expiresAt =
    input.expiresAt === undefined
      ? new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 86_400_000)
      : input.expiresAt

  const code = generateCode()

  const id = randomUUID()
  await db.insert(invites).values({
    id,
    codeHash: hashCode(code),
    codeEncrypted: sealCode(code),
    label,
    email,
    maxUses,
    expiresAt,
    createdBy: input.createdBy?.toLowerCase() ?? null,
  })

  return {
    id,
    code: normaliseCode(code) ?? code,
    formattedCode: formatCode(code),
    email,
    expiresAt,
  }
}

/** One invite by id, or null. */
export async function getInvite(id: string): Promise<Invite | null> {
  const row = await db.query.invites.findFirst({ where: eq(invites.id, id) })
  return row ?? null
}

/**
 * Look up an invite by the code someone submitted.
 *
 * Returns the row whatever its state, so the caller can distinguish "no such
 * code" from "expired" internally — the *user* is told the same sentence either
 * way. A malformed code is a miss rather than an error.
 */
export async function findInviteByCode(code: string): Promise<Invite | null> {
  const canonical = normaliseCode(code)
  if (!canonical) return null

  const row = await db.query.invites.findFirst({
    where: eq(invites.codeHash, hashCode(canonical)),
  })
  return row ?? null
}

/** Revoke an invite. Redeeming it afterwards is refused exactly like a miss. */
export async function revokeInvite(id: string): Promise<boolean> {
  const result = await db
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(eq(invites.id, id))
  return result.rowsAffected > 0
}

/**
 * Remove an invite entirely.
 *
 * Different from revoking: a revoked invite is evidence that a link existed and
 * was killed, while a deleted one leaves `/admin` cleaner. The redemption rows
 * go with it (cascade), so the funnel loses those redemptions — which is why the
 * button says "Delete" and not "Revoke".
 */
export async function deleteInvite(id: string): Promise<boolean> {
  const result = await db.delete(invites).where(eq(invites.id, id))
  return result.rowsAffected > 0
}

/** Newest first, with the two numbers the operator page shows per invite. */
export async function listInvites(): Promise<InviteSummary[]> {
  const rows = await db.query.invites.findMany({
    orderBy: (table, { desc: descOrder }) => [descOrder(table.createdAt)],
  })

  if (rows.length === 0) return []

  const redemptions = await db.query.inviteRedemptions.findMany()
  const ownersWithMailbox = new Set(
    (await db.select({ userId: accounts.userId }).from(accounts))
      .map((row) => row.userId)
      .filter((userId): userId is string => Boolean(userId)),
  )

  const byInvite = new Map<string, string[]>()
  for (const redemption of redemptions) {
    const users = byInvite.get(redemption.inviteId) ?? []
    users.push(redemption.userId)
    byInvite.set(redemption.inviteId, users)
  }

  return rows.map((row) => {
    const people = byInvite.get(row.id) ?? []
    return {
      id: row.id,
      label: row.label,
      email: row.email,
      maxUses: row.maxUses,
      useCount: row.useCount,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      notifiedAt: row.notifiedAt,
      notifyError: row.notifyError,
      createdAt: row.createdAt,
      // Null when no encryption key was configured at creation, or if the
      // stored envelope no longer decrypts — the page offers a new link then.
      code: tryDecrypt(row.codeEncrypted),
      redeemed: people.length,
      activated: people.filter((id) => ownersWithMailbox.has(id)).length,
    }
  })
}

/**
 * Record that the approval email was accepted by a mailbox.
 *
 * Separate from `createInvite` because the two can fail independently: an
 * approval is a decision, and a mail provider having a bad minute must not undo
 * it.
 */
export async function markInviteNotified(id: string): Promise<void> {
  await db
    .update(invites)
    .set({ notifiedAt: new Date(), notifyError: null })
    .where(eq(invites.id, id))
}

/** Record a failed send, so `/admin` can offer a resend with the reason. */
export async function markInviteNotifyFailed(
  id: string,
  message: string,
): Promise<void> {
  await db
    .update(invites)
    .set({ notifyError: message.slice(0, 500) })
    .where(eq(invites.id, id))
}

/** The most recently created invite for an address, used by the request queue. */
export async function latestInviteForEmail(
  email: string,
): Promise<Invite | null> {
  const row = await db.query.invites.findFirst({
    where: eq(invites.email, email.trim().toLowerCase()),
    orderBy: desc(invites.createdAt),
  })
  return row ?? null
}
