/**
 * Earlier threads with one correspondent.
 *
 * A profile refreshed from only the open thread can never learn what it missed:
 * the relationship is usually established across months of mail, and the thread
 * that happens to be on screen is often a single invoice or a one-line reply.
 * This reads the other conversations with the same address as bounded evidence,
 * so the context updater can keep durable facts instead of re-deriving them.
 *
 * Only threads the correspondent has written in are returned — a thread they
 * merely received says less about them than one they answered. The current
 * thread is excluded by the caller because it is already in the prompt.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { conversations, messages } from '#/db/schema.ts'
import type { ConversationState } from '#/db/schema.ts'
import { listAccounts } from '#/lib/auth/accounts.ts'

import { normaliseContactEmail } from './matching.ts'

export type ContactHistoryMessage = {
  /** Display name when the header carried one, otherwise the address. */
  sender: string
  sentAt: string
  body: string
}

export type ContactHistoryThread = {
  providerThreadId: string
  subject: string
  /** Oldest to newest, so a prompt can read it like the current thread. */
  messages: ContactHistoryMessage[]
}

/** How many other threads a refresh may read. */
const MAX_THREADS = 6

/** How many messages from one thread, newest first before reversal. */
const MAX_MESSAGES_PER_THREAD = 4

/** Total messages across every thread, so a busy correspondent stays bounded. */
const MAX_TOTAL_MESSAGES = 30

const MAX_BODY_CHARS = 1_200

/** One thread on the contact overview: enough to identify it, not to render it. */
export type ContactThread = {
  /** The mailbox holding this copy, so a page can key duplicates apart. */
  accountId: string
  providerThreadId: string
  subject: string
  state: ConversationState
  topic: string | null
  /** ISO string, because this crosses the server-function boundary. */
  lastMessageAt: string
  messageCount: number
  importance: number
  unread: boolean
  done: boolean
}

/**
 * Every stored thread this address appears on, newest first.
 *
 * Participant matching rather than writer matching: a thread the user started
 * with the contact is still a thread with them even if they have not replied
 * yet. The row count is one per stored mailbox copy, which is the same unit the
 * inbox files and opens.
 */
export async function listContactThreads(
  userId: string,
  email: string,
): Promise<ContactThread[]> {
  const address = normaliseContactEmail(email)
  if (!address) return []

  const accounts = await listAccounts(userId)
  if (accounts.length === 0) return []

  const rows = await db
    .select({
      accountId: conversations.accountId,
      providerThreadId: conversations.providerThreadId,
      subject: conversations.subject,
      state: conversations.state,
      topic: conversations.topic,
      lastMessageAt: conversations.lastMessageAt,
      messageCount: conversations.messageCount,
      importance: conversations.importance,
      unread: conversations.unread,
      doneAt: conversations.doneAt,
      doneMessageAt: conversations.doneMessageAt,
    })
    .from(conversations)
    .where(
      and(
        inArray(
          conversations.accountId,
          accounts.map((account) => account.id),
        ),
        sql`exists (
          select 1
          from json_each(${conversations.participants}) as participant
          where lower(json_extract(participant.value, '$.email')) = ${address}
        )`,
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))

  return rows.map((row) => ({
    accountId: row.accountId,
    providerThreadId: row.providerThreadId,
    subject: row.subject,
    state: row.state,
    topic: row.topic,
    lastMessageAt: row.lastMessageAt.toISOString(),
    messageCount: row.messageCount,
    importance: row.importance,
    unread: row.unread === true,
    // A mark the thread has outrun is not a done thread; the same rule the
    // inbox uses, restated here because only the two timestamps were selected.
    done:
      row.doneAt !== null &&
      row.doneMessageAt !== null &&
      row.lastMessageAt.getTime() <= row.doneMessageAt.getTime(),
  }))
}

/** The newest thread a contact appears on, for the contacts directory. */
export type ContactActivity = {
  subject: string
  /** ISO string, because this crosses the server-function boundary. */
  lastMessageAt: string
}

/**
 * Newest thread per address, in one read.
 *
 * The directory draws a latest-thread line per row, and asking per contact
 * would be one query per person. Reading the conversation rows newest-first and
 * keeping the first sighting of each participant gives the same answer in one
 * pass without touching message bodies.
 */
export async function listContactActivity(
  userId: string,
): Promise<Map<string, ContactActivity>> {
  const accounts = await listAccounts(userId)
  if (accounts.length === 0) return new Map()

  const rows = await db
    .select({
      subject: conversations.subject,
      lastMessageAt: conversations.lastMessageAt,
      participants: conversations.participants,
    })
    .from(conversations)
    .where(
      inArray(
        conversations.accountId,
        accounts.map((account) => account.id),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))

  const activity = new Map<string, ContactActivity>()
  for (const row of rows) {
    for (const participant of row.participants) {
      const email = normaliseContactEmail(participant.email)
      if (!email || activity.has(email)) continue
      activity.set(email, {
        subject: row.subject,
        lastMessageAt: row.lastMessageAt.toISOString(),
      })
    }
  }
  return activity
}

export type ContactHistoryOptions = {
  /** The thread already in the prompt; omitted from the result. */
  excludeProviderThreadId?: string
  /** Other threads to return at most. */
  limit?: number
}

/**
 * Recent threads with `email`, newest first.
 *
 * Two queries rather than a join per thread: the first finds which
 * conversations the address has written in, the second reads a bounded slice of
 * their messages. The address lives in a JSON column, so the match uses SQLite's
 * `json_extract` rather than loading every message into the app.
 */
export async function loadContactHistory(
  userId: string,
  email: string,
  options: ContactHistoryOptions = {},
): Promise<ContactHistoryThread[]> {
  const address = normaliseContactEmail(email)
  if (!address) return []

  const accounts = await listAccounts(userId)
  if (accounts.length === 0) return []

  const limit = Math.max(1, options.limit ?? MAX_THREADS)
  const rows = await db
    .select({
      id: conversations.id,
      providerThreadId: conversations.providerThreadId,
      subject: conversations.subject,
      lastMessageAt: conversations.lastMessageAt,
    })
    .from(conversations)
    .innerJoin(messages, eq(messages.conversationId, conversations.id))
    .where(
      and(
        inArray(
          conversations.accountId,
          accounts.map((account) => account.id),
        ),
        sql`lower(json_extract(${messages.from}, '$.email')) = ${address}`,
      ),
    )
    .groupBy(conversations.id)
    .orderBy(desc(conversations.lastMessageAt))
    // One extra so excluding the current thread still leaves a full result.
    .limit(limit + 1)

  // A thread id is mailbox-scoped, but the address is not: Gmail and Outlook can
  // report different ids for the same conversation. Excluding the id the caller
  // named is enough here because the prompt is only avoiding duplicate text.
  const threads = rows
    .filter((row) => row.providerThreadId !== options.excludeProviderThreadId)
    .slice(0, limit)
  if (threads.length === 0) return []

  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  const messageRows = await db
    .select({
      conversationId: messages.conversationId,
      from: messages.from,
      body: messages.bodyText,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(
      inArray(
        messages.conversationId,
        threads.map((thread) => thread.id),
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(MAX_TOTAL_MESSAGES)

  const grouped = new Map<
    string,
    Array<{ sender: string; sentAt: string; body: string }>
  >()
  for (const message of messageRows) {
    const thread = byId.get(message.conversationId)
    if (!thread || !message.body?.trim()) continue
    const list = grouped.get(thread.id) ?? []
    // Newest first while reading; reversed below so the prompt reads oldest to
    // newest like the current thread.
    list.push({
      sender: message.from.name?.trim() || message.from.email,
      sentAt: message.sentAt.toISOString(),
      body: message.body.slice(0, MAX_BODY_CHARS),
    })
    grouped.set(thread.id, list)
  }

  return threads.flatMap((thread) => {
    const list = (grouped.get(thread.id) ?? [])
      .slice(0, MAX_MESSAGES_PER_THREAD)
      .reverse()
    if (list.length === 0) return []
    return [
      {
        providerThreadId: thread.providerThreadId,
        subject: thread.subject,
        messages: list,
      },
    ]
  })
}
