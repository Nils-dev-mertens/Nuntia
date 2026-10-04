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
  buildConversation,
  getParsingProfileContext,
  saveConversation,
} from '#/lib/conversation/index.ts'
import type { ParsingProfileContext } from '#/lib/conversation/index.ts'
import { setHistoryId } from '#/lib/auth/accounts.ts'

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

/** Threads fetched concurrently. Higher risks rate limits for no real gain. */
const CONCURRENCY = 4

/**
 * Run a bounded number of tasks at once.
 *
 * Deliberately simple: no queue library, and no retry. Rate-limit handling lives
 * at the sync level where a backoff actually helps, rather than per request.
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
    const attachments = messages.flatMap((m) =>
      toAttachmentRefs(m).map((ref) => ({
        gmailMessageId: m.id,
        gmailAttachmentId: ref.attachmentId,
        filename: ref.filename,
        mimeType: ref.mimeType,
        sizeBytes: ref.sizeBytes,
        isInline: ref.isInline,
        contentId: ref.contentId,
      })),
    )

    const conversation = buildConversation(parsed, {
      ownerEmail: accountId,
      gmailThreadId: thread.id,
      attachments,
      ...profileContext,
    })

    // Bytes are not downloaded here — only metadata is recorded. The attachment
    // cache fetches on demand when something actually needs the file.
    await saveConversation(accountId, conversation)

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
      message: error instanceof Error ? error.message : 'unknown error',
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
          message: error instanceof Error ? error.message : 'unknown error',
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
          message: error instanceof Error ? error.message : 'unknown error',
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
