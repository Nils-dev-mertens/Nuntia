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

import type { MailboxClient, ProviderMessage, ProviderThread } from './types.ts'
import {
  isDraft,
  isTrashed,
  toParsedMessage,
  toThreadAttachmentRefs,
} from '#/lib/mailbox/message.ts'
import {
  applyDecision,
  buildConversation,
  decideConversation,
  getParsingProfileContext,
  getStoredUserFields,
  listConversations,
  listIgnoredSenders,
  listUnreplyableSenders,
  otherPartyOf,
  recordDecision,
  saveConversation,
} from '#/lib/conversation/index.ts'
import type {
  Conversation,
  Decision,
  DecisionPipeline,
  ParsingProfileContext,
} from '#/lib/conversation/index.ts'
import { listAccounts, setCursor } from '#/lib/auth/accounts.ts'
import { cursorKindFor } from './types.ts'
import { loadDecisionPipeline } from '#/lib/ai/index.ts'
import { listContactDecisionContextByEmail } from '#/lib/contacts/context.ts'
import type { ContactDecisionContext } from '#/lib/contacts/context.ts'

/** Progress callback, so a long backfill can report what it is doing. */
export type SyncProgress = (event: SyncEvent) => void

export type SyncEvent =
  | { type: 'start'; mode: 'backfill' | 'incremental'; total?: number }
  /**
   * The work ahead, once the id listing is done. Emitted separately from
   * `start` because the count is not known until `threads.list` has finished
   * paging — the first backfill of a large mailbox is exactly the run that needs
   * to say how far along it is, and it cannot say so when it begins.
   */
  | { type: 'listed'; total: number }
  | { type: 'thread'; threadId: string; messages: number }
  | { type: 'skipped'; threadId: string; reason: string }
  | { type: 'error'; threadId: string; message: string }
  | {
      type: 'done'
      mode: 'backfill' | 'incremental'
      synced: number
      skipped: number
    }

/**
 * What the user has told the app about senders, as the decision layer consumes
 * it.
 *
 * The two sets travel together because the same decision reads both, and both are
 * per *sender* rather than per thread: `ignored` is a sender whose notices have
 * been filed away before, `unreplyable` one the user has marked as unreachable.
 * Loading them once per batch and passing them down is what keeps a sync from
 * asking the same two questions per thread.
 */
export type SenderFacts = {
  ignored: ReadonlySet<string>
  unreplyable: ReadonlySet<string>
  contactContext: ReadonlyMap<string, ContactDecisionContext>
}

/** Read sender signals and user-authored contact ratings once for a batch. */
async function loadSenderFacts(
  accountId: string,
  userId: string,
): Promise<SenderFacts> {
  const [ignored, unreplyable, contactContext] = await Promise.all([
    listIgnoredSenders(accountId),
    listUnreplyableSenders(accountId),
    listContactDecisionContextByEmail(userId),
  ])

  return { ignored, unreplyable, contactContext }
}

export type SyncOptions = {
  /**
   * The person who owns this mailbox.
   *
   * Required, because the decision pipeline is per user: syncing a mailbox has
   * to build it from its owner's AI settings and nobody else's.
   */
  userId: string
  /** Cursor for incremental sync. Absent triggers a backfill. */
  startHistoryId?: string | null
  /** Threads per page. */
  pageSize?: number
  /** Gmail search query for backfill, e.g. `is:unread newer_than:7d`. */
  query?: string
  /** Stop after this many threads (testing / partial sync). */
  limit?: number
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
function relevantMessages(messages: ProviderMessage[]): ProviderMessage[] {
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
  // Nullable in the cast as well as optional: a thrown `null` is legal, and the
  // optional chain is what keeps that from throwing inside the error handler.
  const cause = (error as { cause?: unknown } | null | undefined)?.cause
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
  opts: {
    /** Whose AI settings the decision is made with. */
    userId: string
    /**
     * Reused across a batch. Omitted means "read the settings now", which is
     * what the single-thread callers want; a batch must not decrypt and rebuild
     * per row.
     */
    pipeline?: DecisionPipeline
    /**
     * What the user has taught the app about senders, reused across a batch.
     *
     * Omitted means "read them now" — two queries, for the single-thread
     * callers. A sync reads its mail in a loop, so it loads them once and passes
     * them down rather than asking the same questions per thread.
     */
    senderFacts?: SenderFacts
  },
): Promise<{ decision: Decision; conversation: Conversation }> {
  // A thread rebuilt from Gmail carries no memory of the user's own calls — that
  // lives on the stored row — so it is read back and put on before the decision
  // is applied, which is what makes `applyDecision` able to keep it. Assigned
  // rather than merged: the caller's copy can be older than the row (a restore
  // clears the call *and* re-decides the conversation it was loaded from), and
  // trusting it there would put back the call the user just took away.
  //
  // All three user-owned fields travel together: the same reason applies to what
  // the user has read and to the Done mark, and reading them in one query means a
  // rebuild cannot carry one and silently reset another.
  const storedUserFields = await getStoredUserFields(
    accountId,
    conversation.providerThreadId,
  )
  const withCall: Conversation = { ...conversation, ...storedUserFields }

  const senderFacts =
    opts.senderFacts ?? (await loadSenderFacts(accountId, opts.userId))
  const otherParty = otherPartyOf(withCall)

  const decision = await decideConversation(
    {
      subject: withCall.subject,
      messages: withCall.messages,
      ownerEmail: accountId,
      goal: withCall.goal,
      decidedAt: null,
      ignoredSender: senderFacts.ignored.has(otherParty),
      // The user's own mark on this sender, which settles replyability before
      // the model is asked — and which a re-decide must therefore read from the
      // stored preference rather than infer.
      unreplyableSender: senderFacts.unreplyable.has(otherParty),
      senderImportance:
        senderFacts.contactContext.get(otherParty)?.importance ?? null,
      senderContext: senderFacts.contactContext.get(otherParty) ?? null,
    },
    opts.pipeline ?? (await loadDecisionPipeline(opts.userId)),
  )
  const updated = applyDecision(withCall, decision)

  await saveConversation(accountId, updated)
  await recordDecision(updated, decision)

  return { decision, conversation: updated }
}

/**
 * Re-run the decision pipeline over every conversation already stored.
 *
 * Incremental sync only revisits threads Gmail reports as changed, so a change
 * to *how* a thread is classified — a rule, a Jev question — otherwise reaches
 * only mail that happens to change afterwards. This applies it to what is
 * already in the database, from the stored messages, with no Gmail round trip.
 *
 * The alternative is forgetting the mailbox and syncing again, which also wipes
 * the user's own topics and goals (the account row cascades) and re-backfills
 * only the `newer_than:` window.
 *
 * The whole batch shares one pipeline, but each conversation is still a decision
 * (and, with an LLM configured, a topic call). A failure on one row is reported
 * and skipped rather than thrown: this runs from a load path, and one bad
 * conversation must not blank the inbox.
 */
export async function redecideConversationsForSender(
  userId: string,
  senderEmail: string,
): Promise<number> {
  const sender = senderEmail.trim().toLowerCase()
  if (!sender) return 0

  const accounts = await listAccounts(userId)
  if (accounts.length === 0) return 0
  const pipeline = await loadDecisionPipeline(userId)
  let redecided = 0

  for (const account of accounts) {
    const [conversations, senderFacts] = await Promise.all([
      listConversations(account.id, { includeArchived: true }),
      loadSenderFacts(account.id, userId),
    ])
    const matching = conversations.filter((conversation) =>
      conversation.messages.some(
        (message) =>
          !message.isFromOwner &&
          message.from.email.trim().toLowerCase() === sender,
      ),
    )

    for (const conversation of matching) {
      try {
        await decideAndSave(account.id, conversation, {
          userId,
          pipeline,
          senderFacts,
        })
        redecided++
      } catch (error) {
        console.error(
          `[contact] could not re-decide ${conversation.providerThreadId}:`,
          reasonOf(error),
        )
      }
    }
  }

  return redecided
}

export async function redecideStoredConversations(
  accountId: string,
  userId: string,
): Promise<number> {
  const conversations = await listConversations(accountId, {
    includeArchived: true,
  })
  if (conversations.length === 0) return 0

  const pipeline = await loadDecisionPipeline(userId)
  const senderFacts = await loadSenderFacts(accountId, userId)

  let redecided = 0
  for (const conversation of conversations) {
    try {
      await decideAndSave(accountId, conversation, {
        userId,
        pipeline,
        senderFacts,
      })
      redecided++
    } catch (error) {
      console.error(
        `[derived] could not re-decide ${conversation.providerThreadId}:`,
        reasonOf(error),
      )
    }
  }

  return redecided
}

/**
 * Turn one thread into a conversation and persist it.
 *
 * Drafts and trashed messages are excluded — the inbox should show what people
 * actually sent the user.
 */
export async function syncThread(
  accountId: string,
  thread: ProviderThread,
  opts: {
    /** The mailbox's owner, whose AI settings the decision uses. */
    userId: string
    onProgress?: SyncProgress
    profileContext?: ParsingProfileContext
    /**
     * What the user has taught the app about senders. A batch loads this once
     * and passes it to every thread; omitted means `decideAndSave` reads it for
     * this one.
     */
    senderFacts?: SenderFacts
  },
): Promise<'synced' | 'skipped' | 'error'> {
  const { onProgress, profileContext, senderFacts } = opts
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
    // rather than in the decoded parts, so it is collected separately — and by
    // a shared helper, because the send path rebuilds a thread the same way.
    const attachments = toThreadAttachmentRefs(messages, parsed)

    const built = buildConversation(parsed, {
      ownerEmail: accountId,
      providerThreadId: thread.id,
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
    await decideAndSave(accountId, built, {
      userId: opts.userId,
      senderFacts,
    })

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
  client: MailboxClient,
  accountId: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const pageSize = opts.pageSize ?? 100
  const onProgress = opts.onProgress

  onProgress?.({ type: 'start', mode: 'backfill' })

  // A provider can report the same thread on more than one page (Graph lists
  // messages, not threads), and refetching it would double the work.
  const threadIds: string[] = []
  const seenThreadIds = new Set<string>()
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
      if (!t.id || seenThreadIds.has(t.id)) continue
      seenThreadIds.add(t.id)
      threadIds.push(t.id)
    }

    estimated = page.resultSizeEstimate ?? estimated
    pageToken = page.nextPageToken ?? undefined

    // Stop paginating once we have enough to work with.
    if (opts.limit && threadIds.length >= opts.limit) break
  } while (pageToken)

  const targets = opts.limit ? threadIds.slice(0, opts.limit) : threadIds
  const profileContext = await getParsingProfileContext(accountId)
  const senderFacts = await loadSenderFacts(accountId, opts.userId)

  onProgress?.({ type: 'listed', total: targets.length })

  const results = await mapWithConcurrency(
    targets,
    CONCURRENCY,
    async (threadId) => {
      // A single failed fetch must not reject the whole batch and abandon the
      // remaining threads — report it and carry on.
      try {
        const thread = await client.getThread(threadId)
        return syncThread(accountId, thread, {
          userId: opts.userId,
          onProgress,
          profileContext,
          senderFacts,
        })
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
  await setCursor(accountId, cursorKindFor(client.provider), historyId)

  const synced = results.filter((r) => r === 'synced').length
  const skipped = results.filter((r) => r !== 'synced').length

  onProgress?.({ type: 'done', mode: 'backfill', synced, skipped })

  return { synced, skipped, cursor: historyId, estimated }
}

/**
 * Sync changes since a stored cursor.
 *
 * This is the cheap path: `history.list` returns ids of messages that changed,
 * and we refetch only the threads containing them.
 */
export async function syncIncremental(
  client: MailboxClient,
  accountId: string,
  startHistoryId: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const onProgress = opts.onProgress

  onProgress?.({ type: 'start', mode: 'incremental' })

  const threadIds = new Set<string>()
  let pageToken: string | undefined
  let latestCursor: string | null = null

  do {
    const page = await client.listHistory({ startHistoryId, pageToken })

    for (const h of page.history) {
      for (const m of h.messages) {
        if (m.threadId) threadIds.add(m.threadId)
      }
    }

    latestCursor = page.cursor ?? latestCursor
    pageToken = page.nextPageToken ?? undefined
  } while (pageToken)

  const targets = opts.limit
    ? [...threadIds].slice(0, opts.limit)
    : [...threadIds]
  const profileContext = await getParsingProfileContext(accountId)
  const senderFacts = await loadSenderFacts(accountId, opts.userId)

  onProgress?.({ type: 'listed', total: targets.length })

  const results = await mapWithConcurrency(
    targets,
    CONCURRENCY,
    async (threadId) => {
      try {
        const thread = await client.getThread(threadId)
        return syncThread(accountId, thread, {
          userId: opts.userId,
          onProgress,
          profileContext,
          senderFacts,
        })
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
  await setCursor(accountId, cursorKindFor(client.provider), historyId)

  const synced = results.filter((r) => r === 'synced').length
  const skipped = results.filter((r) => r !== 'synced').length

  onProgress?.({ type: 'done', mode: 'incremental', synced, skipped })

  return { synced, skipped, cursor: historyId, estimated: threadIds.size }
}

export type SyncResult = {
  synced: number
  skipped: number
  cursor: string
  estimated: number
}

/**
 * Sync with whichever strategy the cursor calls for.
 *
 * The single entry point callers should use: a missing or empty cursor means
 * backfill, otherwise incremental.
 */
export async function sync(
  client: MailboxClient,
  accountId: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  if (opts.startHistoryId) {
    try {
      return await syncIncremental(client, accountId, opts.startHistoryId, opts)
    } catch (error) {
      // A stale cursor — older than Gmail's retention, or a value the provider
      // no longer recognises — cannot resume. Recover by rebuilding from
      // scratch rather than leaving the user stuck.
      if (
        error instanceof Error &&
        (error.name === 'GmailNotFoundError' ||
          error.name === 'MailboxCursorExpiredError')
      ) {
        return backfill(client, accountId, opts)
      }
      throw error
    }
  }

  return backfill(client, accountId, opts)
}
