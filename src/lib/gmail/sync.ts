/**
 * Sync orchestration.
 *
 * Two modes:
 *
 * - **Initial backfill** — walk `threads.list`, fetch each thread, persist.
 * - **Incremental** — `history.list` from the stored cursor, which is cheap
 *   enough to run often and is what makes the app feel live.
 *
 * The Gmail API client is injected, so all of this is testable without network.
 */

import type { GmailClient, GmailMessage, GmailThread } from './client.ts'
import {
  isDraft,
  isTrashed,
  toAttachmentRefs,
  toParsedMessage,
} from './message.ts'
import {
  applyDecision,
  buildConversation,
  decideConversation,
  getParsingProfileContext,
  recordDecision,
  saveConversation,
} from '#/lib/conversation/index.ts'
import type {
  Conversation,
  Decision,
  ParsingProfileContext,
} from '#/lib/conversation/index.ts'
import { setHistoryId } from '#/lib/auth/accounts.ts'
import { loadDecisionPipeline } from '#/lib/ai/index.ts'

/** Progress callback, so a long backfill can report what it is doing. */
export type SyncProgress = (event: SyncEvent) => void

export type SyncEvent =
  | { type: 'start'; mode: 'backfill' | 'incremental'; total?: number }
  | { type: 'thread'; threadId: string; messages: number }
  | { type: 'skipped'; threadId: string; reason: string }
  | { type: 'error'; threadId: string; message: string }
  | {
      type: 'done'
      mode: 'backfill' | 'incremental'
      synced: number
      skipped: number
    }

export type SyncOptions = {
  /** Cursor for incremental sync. Absent triggers a backfill. */
  startHistoryId?: string | null
  /** Threads per page. */
  pageSize?: number
  /** Gmail search query for backfill, e.g. `is:unread newer_than:7d`. */
  query?: string
  /** Stop after this many threads (testing / partial sync). */
  limit?: number
  /** Skip attachment downloads entirely. */
  downloadAttachments?: boolean
  onProgress?: SyncProgress
}

/**
 * Threads fetched concurrently.
 *
 * Kept low deliberately: each `threads.get` costs quota, and fetching four at
 * once is enough to trip Gmail's per-user "Total Query Cost" limit on a real
 * mailbox. Backoff-and-retry lives in `client.ts`, so a burst is recoverable
 * rather than fatal — but the cheapest fix is not to create the burst.
 */
const CONCURRENCY = 2

/**
 * Run a bounded number of tasks at once.
 *
 * Deliberately simple: no queue library. Rate-limit handling lives one layer
 * down in `client.ts`, which retries a rate-limited request with backoff, so a
 * worker here never has to know the difference.
 */
async function mapWithConcurrency<T, TResult>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(items.length)
  let cursor = 0

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run()),
  )

  return results
}

/** Messages worth turning into conversation bubbles. */
function relevantMessages(messages: GmailMessage[]): GmailMessage[] {
  return messages.filter((m) => !isDraft(m) && !isTrashed(m))
}

/**
 * The underlying reason for a failure.
 *
 * A Drizzle query error's own `message` is the SQL plus every bound parameter,
 * which buries the actual cause ("UNIQUE constraint failed: …") in `cause`. The
 * short reason is surfaced so a sync log names the problem instead of the query.
 */
function reasonOf(error: unknown): string {
  const cause = (error as { cause?: unknown })?.cause
  if (cause instanceof Error && cause.message) return cause.message
  if (error instanceof Error && error.message) return error.message
  return 'unknown error'
}

/**
 * Run the decision pipeline over an already-built conversation and persist it.
 *
 * Split out of `syncThread` so the manual re-analyse action reuses the exact
 * path a sync takes — rules, then Jev and the topic generator when configured —
 * against a conversation that is already in the database, without a Gmail round
 * trip.
 */
export async function decideAndSave(
  accountId: string,
  conversation: Conversation,
): Promise<{ decision: Decision; conversation: Conversation }> {
  const decision = await decideConversation(
    {
      subject: conversation.subject,
      messages: conversation.messages,
      ownerEmail: accountId,
      goal: conversation.goal,
      decidedAt: null,
    },
    await loadDecisionPipeline(),
  )
  const updated = applyDecision(conversation, decision)

  await saveConversation(accountId, updated)
  await recordDecision(updated, decision)

  return { decision, conversation: updated }
}

/**
 * Turn one thread into a conversation and persist it.
 *
 * Drafts and trashed messages are excluded — the inbox should show what people
 * actually sent the user.
 */
export async function syncThread(
  accountId: string,
  thread: GmailThread,
  onProgress?: SyncProgress,
  profileContext?: ParsingProfileContext,
): Promise<'synced' | 'skipped' | 'error'> {
  const messages = relevantMessages(thread.messages)

  if (messages.length === 0) {
    onProgress?.({
      type: 'skipped',
      threadId: thread.id,
      reason: 'no relevant messages',
    })
    return 'skipped'
  }

  try {
    const parsed = messages.map(toParsedMessage)

    // Gmail's structured payload carries attachment metadata in the MIME tree
    // rather than in the decoded parts, so it is collected separately.
    //
    // Each ref is tagged with the identity the *message row* is keyed by — the
    // parsed `messageId`, which is the RFC 5322 Message-ID — not Gmail's own
    // message id. The messages table and the attachment's `message_id` foreign
    // key have to agree, or every thread that carries an attachment fails to
    // save as a whole (SQLITE_CONSTRAINT: FOREIGN KEY constraint failed).
    const attachments = messages.flatMap((message, index) => {
      const parsedMessage = parsed[index]
      const messageKey = parsedMessage
        ? parsedMessage.messageId ??
          `synthetic:${parsedMessage.date?.getTime() ?? 0}`
        : message.id

      return toAttachmentRefs(message).map((ref) => ({
        gmailMessageId: messageKey,
        gmailAttachmentId: ref.attachmentId,
        filename: ref.filename,
        mimeType: ref.mimeType,
        sizeBytes: ref.sizeBytes,
        isInline: ref.isInline,
        contentId: ref.contentId,
      }))
    })

    const built = buildConversation(parsed, {
      ownerEmail: accountId,
      gmailThreadId: thread.id,
      attachments,
      ...profileContext,
    })

    // The decision pipeline runs here, in the sync path, once per changed thread:
    // rules first, then the decision model (Jev) and the topic generator (an LLM)
    // when they are configured in the UI. With no keys this is the rule-based
    // default, so the result is identical to what `buildConversation` already
    // derived. `decideAndSave` owns the persist, so the manual re-analyse action
    // takes the same path.
    //
    // Bytes are not downloaded here — only metadata is recorded. The attachment
    // cache fetches on demand when something actually needs the file.
    await decideAndSave(accountId, built)

    onProgress?.({
      type: 'thread',
      threadId: thread.id,
      messages: messages.length,
    })

    return 'synced'
  } catch (error) {
    // One bad thread must not abort a whole sync.
    onProgress?.({
      type: 'error',
      threadId: thread.id,
      message: reasonOf(error),
    })
    return 'error'
  }
}

/**
 * Fetch every thread matching the query and persist conversations.
 *
 * Pages through `threads.list`, so a large mailbox is fetched in bounded
 * requests rather than one enormous call.
 */
export async function backfill(
  client: GmailClient,
  accountId: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const pageSize = opts.pageSize ?? 100
  const onProgress = opts.onProgress

  onProgress?.({ type: 'start', mode: 'backfill' })

  const threadIds: string[] = []
  let pageToken: string | undefined
  let estimated = 0

  // Gather thread ids first, then fetch each thread — the listing endpoint is
  // cheap and lets us respect `limit` without fetching bodies we will discard.
  do {
    const page = await client.listThreads({
      pageToken,
      maxResults: pageSize,
      query: opts.query,
    })

    for (const t of page.threads) {
      if (t.id) threadIds.push(t.id)
    }

    estimated = page.resultSizeEstimate ?? estimated
    pageToken = page.nextPageToken ?? undefined

    // Stop paginating once we have enough to work with.
    if (opts.limit && threadIds.length >= opts.limit) break
  } while (pageToken)

  const targets = opts.limit ? threadIds.slice(0, opts.limit) : threadIds
  const profileContext = await getParsingProfileContext(accountId)

  const results = await mapWithConcurrency(
    targets,
    CONCURRENCY,
    async (threadId) => {
      // A single failed fetch must not reject the whole batch and abandon the
      // remaining threads — report it and carry on.
      try {
        const thread = await client.getThread(threadId)
        return syncThread(accountId, thread, onProgress, profileContext)
      } catch (error) {
        onProgress?.({
          type: 'error',
          threadId,
          message: reasonOf(error),
        })
        return 'error'
      }
    },
  )

  // Advance the cursor so the next incremental run starts from here.
  const historyId = await client.getProfileHistoryId()
  await setHistoryId(accountId, historyId)

  const synced = results.filter((r) => r === 'synced').length
  const skipped = results.filter((r) => r !== 'synced').length

  onProgress?.({ type: 'done', mode: 'backfill', synced, skipped })

  return { synced, skipped, historyId, estimated }
}

/**
 * Sync changes since a stored cursor.
 *
 * This is the cheap path: `history.list` returns ids of messages that changed,
 * and we refetch only the threads containing them.
 */
export async function syncIncremental(
  client: GmailClient,
  accountId: string,
  startHistoryId: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const onProgress = opts.onProgress

  onProgress?.({ type: 'start', mode: 'incremental' })

  const threadIds = new Set<string>()
  let pageToken: string | undefined
  let latestHistoryId: string | null = null

  do {
    const page = await client.listHistory({ startHistoryId, pageToken })

    for (const h of page.history) {
      for (const m of h.messages) {
        if (m.threadId) threadIds.add(m.threadId)
      }
    }

    latestHistoryId = page.historyId ?? latestHistoryId
    pageToken = page.nextPageToken ?? undefined
  } while (pageToken)

  const targets = opts.limit
    ? [...threadIds].slice(0, opts.limit)
    : [...threadIds]
  const profileContext = await getParsingProfileContext(accountId)

  const results = await mapWithConcurrency(
    targets,
    CONCURRENCY,
    async (threadId) => {
      try {
        const thread = await client.getThread(threadId)
        return syncThread(accountId, thread, onProgress, profileContext)
      } catch (error) {
        onProgress?.({
          type: 'error',
          threadId,
          message: reasonOf(error),
        })
        return 'error'
      }
    },
  )

  // Gmail's history ids expire after ~7 days; if ours is too old the API
  // returns 404 and a backfill is the only recovery.
  const historyId = await client.getProfileHistoryId()
  await setHistoryId(accountId, historyId)

  const synced = results.filter((r) => r === 'synced').length
  const skipped = results.filter((r) => r !== 'synced').length

  onProgress?.({ type: 'done', mode: 'incremental', synced, skipped })

  return { synced, skipped, historyId, estimated: threadIds.size }
}

export type SyncResult = {
  synced: number
  skipped: number
  historyId: string
  estimated: number
}

/**
 * Sync with whichever strategy the cursor calls for.
 *
 * The single entry point callers should use: a missing or empty cursor means
 * backfill, otherwise incremental.
 */
export async function sync(
  client: GmailClient,
  accountId: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  if (opts.startHistoryId) {
    try {
      return await syncIncremental(client, accountId, opts.startHistoryId, opts)
    } catch (error) {
      // A stale cursor (older than Gmail's retention) 404s. Recover by
      // rebuilding from scratch rather than leaving the user stuck.
      if (error instanceof Error && error.name === 'GmailNotFoundError') {
        return backfill(client, accountId, opts)
      }
      throw error
    }
  }

  return backfill(client, accountId, opts)
}
