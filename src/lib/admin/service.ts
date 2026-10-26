/**
 * The numbers `/admin` shows.
 *
 * All of it is SQL against the tables the app already writes — there is no
 * analytics store, no export, and nothing here reads a subject, a body, or a
 * third party's address. At beta scale every query is small; the shape is
 * chosen for being readable rather than for joining in one statement.
 *
 * The funnel is deliberately six numbers rather than one: "requested" without
 * "approved" is demand you turned down, "approved" without "redeemed" is a link
 * that did not land, and "redeemed" without "activated" is someone who signed up
 * and never connected a mailbox.
 */

import { desc } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import {
  accounts,
  conversations,
  feedback,
  inviteRedemptions,
  productEvents,
  sessions,
  users,
} from '#/db/schema.ts'
import type { FeedbackStatus } from '#/db/schema.ts'

import { aiLogPath, readRecentAiEvents } from '#/lib/ai/ai-log.ts'
import type { AiLogRecord } from '#/lib/ai/ai-log.ts'
import { listInvites } from '#/lib/invites/repository.ts'
import type { InviteSummary } from '#/lib/invites/repository.ts'
import { inviteLink } from '#/lib/invites/notify.ts'
import { listRequests } from '#/lib/invites/requests.ts'
import type { RequestRow } from '#/lib/invites/requests.ts'

export type Funnel = {
  requested: number
  approved: number
  redeemed: number
  /** People with at least one connected mailbox. */
  activated: number
  /** People with at least one thread stored. */
  used: number
  /** People active on more than one day. */
  returned: number
}

export type PersonRow = {
  id: string
  name: string | null
  role: string
  createdAt: Date
  mailboxes: number
  threads: number
  lastActiveAt: Date | null
  inviteId: string | null
}

export type FeedbackRow = {
  id: string
  userId: string
  email: string | null
  rating: number | null
  message: string
  context: string | null
  status: FeedbackStatus
  createdAt: Date
}

/** An invite with the link the operator can copy, built on the server. */
export type AdminInvite = InviteSummary & { link: string | null }

export type AdminData = {
  requests: RequestRow[]
  invites: AdminInvite[]
  people: PersonRow[]
  funnel: Funnel
  feedback: FeedbackRow[]
  /**
   * Recent AI calls, install-wide.
   *
   * Operator-only on purpose: the file has no user id on its records, so it
   * cannot be scoped to one person, and it used to be shown in `/settings` to
   * everyone. It is diagnostic material for whoever runs the install, not a
   * per-user activity feed.
   */
  aiLog: { path: string; events: AiLogRecord[] }
}

export async function loadAdminData(): Promise<AdminData> {
  const [requestRows, inviteRows, userRows, feedbackRows] = await Promise.all([
    listRequests(),
    listInvites(),
    db.query.users.findMany({ orderBy: desc(users.createdAt) }),
    db.query.feedback.findMany({ orderBy: desc(feedback.createdAt) }),
  ])

  const accountRows = await db.select().from(accounts)
  const ownedAccounts = accountRows
    .filter((row): row is typeof row & { userId: string } => Boolean(row.userId))

  const accountOwner = new Map(ownedAccounts.map((row) => [row.id, row.userId]))
  const mailboxesByUser = new Map<string, number>()
  for (const row of ownedAccounts) {
    mailboxesByUser.set(row.userId, (mailboxesByUser.get(row.userId) ?? 0) + 1)
  }

  const threadRows = await db
    .select({ id: conversations.id, accountId: conversations.accountId })
    .from(conversations)

  const threadsByUser = new Map<string, number>()
  for (const thread of threadRows) {
    const owner = accountOwner.get(thread.accountId)
    if (!owner) continue
    threadsByUser.set(owner, (threadsByUser.get(owner) ?? 0) + 1)
  }

  const sessionRows = await db
    .select({ userId: sessions.userId, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)

  const lastActive = new Map<string, Date>()
  for (const row of sessionRows) {
    const current = lastActive.get(row.userId)
    if (!current || current < row.lastSeenAt) {
      lastActive.set(row.userId, row.lastSeenAt)
    }
  }

  const redemptionRows = await db.select().from(inviteRedemptions)
  const invitesByUser = new Map<string, string>()
  for (const row of redemptionRows) invitesByUser.set(row.userId, row.inviteId)

  const eventRows = await db
    .select({ userId: productEvents.userId, createdAt: productEvents.createdAt })
    .from(productEvents)

  const activeDays = new Map<string, Set<string>>()
  for (const row of eventRows) {
    const day = row.createdAt.toISOString().slice(0, 10)
    const days = activeDays.get(row.userId) ?? new Set<string>()
    days.add(day)
    activeDays.set(row.userId, days)

    // `sessions.last_seen_at` is only the latest device, so the event log can
    // hold a more recent day than the session rows do.
    const seen = lastActive.get(row.userId)
    if (!seen || seen < row.createdAt) lastActive.set(row.userId, row.createdAt)
  }

  const people: PersonRow[] = userRows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt,
    mailboxes: mailboxesByUser.get(row.id) ?? 0,
    threads: threadsByUser.get(row.id) ?? 0,
    lastActiveAt: lastActive.get(row.id) ?? null,
    inviteId: invitesByUser.get(row.id) ?? null,
  }))

  const usersWithMailbox = new Set(mailboxesByUser.keys())
  const usersWithThreads = new Set(threadsByUser.keys())
  const usersWithReturn = new Set(
    [...activeDays.entries()]
      .filter(([, days]) => days.size > 1)
      .map(([userId]) => userId),
  )

  const funnel: Funnel = {
    requested: requestRows.length,
    approved: requestRows.filter(
      (row) => row.status === 'approved' || row.status === 'redeemed',
    ).length,
    redeemed: redemptionRows.length,
    activated: usersWithMailbox.size,
    used: usersWithThreads.size,
    returned: usersWithReturn.size,
  }

  return {
    requests: requestRows,
    invites: inviteRows.map((invite) => ({
      ...invite,
      // `inviteLink` needs `LUMEN_APP_URL`, which only the server can read.
      link: invite.code ? inviteLink(invite.code) : null,
    })),
    people,
    funnel,
    feedback: feedbackRows,
    aiLog: {
      path: aiLogPath(),
      events: await readRecentAiEvents(20),
    },
  }
}

export type { InviteSummary, RequestRow }
