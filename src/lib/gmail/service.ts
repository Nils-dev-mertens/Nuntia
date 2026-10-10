/**
 * The inbox, as the application sees it.
 *
 * Everything above this file is a library with no entry point — `sync.ts` takes
 * an injected `GmailClient`, and nothing knows how to build one from a stored
 * account. This module is that missing seam: session account id in, list of
 * conversations out, with the staleness policy applied.
 *
 * It is deliberately the only place that knows all three of: how to authenticate
 * against Google, when to sync, and what the UI needs.
 */

import type { ConversationState } from '#/db/schema.ts'

import {
  getAccountEnvelope,
  getDerivedVersion,
  getHistoryId,
  getLastSyncedAt,
  listAccounts,
  setDerivedVersion,
} from '#/lib/auth/accounts.ts'
import { createGmailClient } from '#/lib/auth/google.ts'
import {
  backfillDerivedFields,
  DERIVED_VERSION,
  getConversationClusterByThreadId,
  getParsingProfileContext,
  listConversations,
  mergeAccountConversations,
  reparseStoredMessages,
} from '#/lib/conversation/index.ts'
import type {
  MergedConversation,
  MergeRelation,
} from '#/lib/conversation/index.ts'
import { createGmailApiClient, GmailAuthError } from './client.ts'
import { DEFAULT_STALE_AFTER_MS, isCursorStale } from './freshness.ts'
import { decideAndSave, sync } from './sync.ts'

/**
 * The first backfill is bounded.
 *
 * Walking a whole mailbox is slow, and `threads.list` pages at 100 per call, so
 * an unbounded first sync on a real account is a multi-minute request that will
 * run into rate limits. Thirty days is enough to be useful immediately; older
 * mail is not worth the first-run cost, and it arrives as the cursor moves on.
 */
export const BACKFILL_QUERY = 'newer_than:30d'

/** One row in the conversation list. */
export type ConversationSummary = {
  id: string
  gmailThreadId: string
  subject: string
  state: ConversationState
  /** No human on the other side — rendered as a compact non-interactive card. */
  isAutomated: boolean
  /** Whether a reply could leave from here — drives the "No reply" tag. */
  replyable: boolean
  /** Which connected mailbox this row belongs to. */
  accountId: string
  accountEmail: string
  /**
   * How the user's accounts stand relative to the thread. A `cc-only` row is
   * someone else's conversation they happen to be copied on.
   */
  relation: MergeRelation
  /** Their other addresses that hold this thread only as a copy. */
  ccAccountEmails: string[]
  participants: Array<{ name: string | null; email: string }>
  messageCount: number
  attachmentCount: number
  /** ISO string — loader data crosses a serialization boundary. */
  lastMessageAt: string
  topic: string | null
  goal: string | null
  importance: number
  urgency: number
  /** First line of the newest message, for the list preview. */
  preview: string | null
}

export type InboxPayload =
  | { signedIn: false }
  | {
      signedIn: true
      /** Every connected mailbox, in connection order. */
      accounts: Array<{ id: string; email: string }>
      conversations: ConversationSummary[]
      /** Every state is present, including zeroes, so the UI can render headers. */
      counts: Record<ConversationState, number>
      /** ISO string of the most recent completed sync, or null if never. */
      lastSyncedAt: string | null
      /** True when this call actually talked to any mailbox. */
      syncedNow: boolean
      /** Set when a sync was attempted and failed; the list is still usable. */
      syncError: string | null
      /**
       * The mailboxes whose Google grant was rejected or revoked. Only these
       * need the "Reconnect" action — one broken mailbox must not blank the
       * others.
       */
      authRequiredAccounts: Array<{ id: string; email: string }>
    }

type SyncOutcome = { error: string | null; authRequired: boolean }

/**
 * What an on-demand Gmail action reports back to the UI: a message to show, and
 * whether signing in to Google again is the way out.
 */
export type ActionFailure = { error: string | null; authRequired: boolean }

/** One message in the detail view. */
export type ConversationMessageView = {
  gmailMessageId: string
  from: { name: string | null; email: string }
  body: string
  /**
   * Sanitized HTML for rich rendering, or null when the message had none.
   *
   * Already quote-stripped, greeting- and signature-stripped, and passed
   * through an allowlist at parse time — so the view can inject it without
   * cleaning it again.
   */
  bodyHtml: string | null
  isFromOwner: boolean
  detectedGreeting: string | null
  detectedSignature: string | null
  strippedGreeting: string | null
  strippedSignature: string | null
  strippedQuote: string | null
  /** ISO string — loader data crosses a serialization boundary. */
  sentAt: string
}

/** Everything the chat view needs for one thread. */
export type ConversationDetail = {
  gmailThreadId: string
  /** The mailbox that owns this thread — where a reply leaves from by default. */
  accountId: string
  accountEmail: string
  /**
   * Every address a reply could leave from, best first. More than one when the
   * thread carries several of the user's connected addresses.
   */
  replyAccounts: Array<{ id: string; email: string }>
  /**
   * Every connected address. A message from one of these is "yours", even when
   * it is not the owning mailbox — the chat view labels those bubbles with the
   * address so a thread between two of the user's own accounts stays readable.
   */
  ownerEmails: string[]
  subject: string
  state: ConversationState
  isAutomated: boolean
  /** False hides the composer — there is nobody to send a reply to. */
  replyable: boolean
  topic: string | null
  goal: string | null
  awaitingReply: boolean
  participants: Array<{ name: string | null; email: string }>
  messages: ConversationMessageView[]
  attachments: Array<{
    gmailMessageId: string
    gmailAttachmentId: string
    filename: string
    mimeType: string
    sizeBytes: number
  }>
  parsingProfile: {
    senderEmail: string
    useAccountParsingDefaults: boolean
    stripQuotedHistory: boolean
    stripGreeting: boolean
    stripSignature: boolean
    defaultStripQuotedHistory: boolean
    defaultStripGreeting: boolean
    defaultStripSignature: boolean
    defaultReplyGreeting: string
    defaultReplySignature: string
    replyStyleEnabled: boolean
    replyGreeting: string
    replySignature: string
  } | null
}

/**
 * Load one conversation for the chat view.
 *
 * Returns null when the thread is not in the database — which is also what a
 * wrong id looks like, so the route renders a not-found rather than an empty
 * thread.
 */
export async function loadConversation(
  gmailThreadId: string,
): Promise<ConversationDetail | null> {
  // Resolve the *cluster*, not just the one stored conversation this thread id
  // names. A thread id is mailbox-scoped, and the mailbox it points at may hold
  // only a fragment of the conversation — Gmail does not always group a message
  // the same way in the sender's and recipient's mailboxes. The inbox merges the
  // Message-ID-connected component; the detail view must render the same one, or
  // clicking a merged row shows one account's fragment and hides the rest.
  const cluster = await getConversationClusterByThreadId(gmailThreadId)
  if (!cluster || cluster.length === 0) return null

  const accountRows = await listAccounts()
  const accounts = accountRows.map((account) => ({
    id: account.id,
    email: account.email,
  }))

  // The cluster is one connected component, so it folds into a single row.
  const merged = mergeAccountConversations(cluster, accounts).at(0)
  if (!merged) return null

  const accountId = merged.ownerAccountId
  const conversation = merged.conversation
  const messages = conversation.messages

  // "Mine" is the whole connected set, so a message from another of the user's
  // own addresses is theirs rather than a stranger's.
  const owners = new Set(
    accountRows.map((account) => account.email.trim().toLowerCase()),
  )

  const profileContext = await getParsingProfileContext(accountId)

  // Ordered by the merge, not by `accounts`: the composer defaults to the first
  // entry, and that has to be the owning mailbox rather than whichever account
  // happens to have been inserted first.
  const accountById = new Map(accounts.map((account) => [account.id, account]))
  const replyAccounts = merged.replyAccountIds
    .map((id) => accountById.get(id))
    .filter((account): account is { id: string; email: string } =>
      Boolean(account),
    )

  // The sender profile is for the *other* party. One of the user's own addresses
  // is not a sender to tune for, even when it is not the owning mailbox, so those
  // are excluded rather than treated as a correspondent.
  const otherSender = [...messages]
    .reverse()
    .find((message) => !owners.has(message.from.email.trim().toLowerCase()))
    ?.from.email
  const senderEmail = otherSender?.trim().toLowerCase() ?? null
  const senderParsing = senderEmail
    ? profileContext.parsingProfiles[senderEmail]
    : undefined
  const senderStyle = senderEmail
    ? profileContext.replyStyles.senders[senderEmail]
    : undefined

  return {
    gmailThreadId: conversation.gmailThreadId,
    accountId,
    accountEmail:
      accounts.find((account) => account.id === accountId)?.email ?? accountId,
    replyAccounts,
    ownerEmails: [...owners],
    subject: conversation.subject,
    state: conversation.state,
    isAutomated: conversation.isAutomated,
    replyable: conversation.replyable,
    topic: conversation.topic,
    goal: conversation.goal,
    awaitingReply: conversation.awaitingReply,
    participants: conversation.participants.map((p) => ({
      name: p.name ?? null,
      email: p.email,
    })),
    messages: messages.map((m) => ({
      gmailMessageId: m.gmailMessageId,
      from: { name: m.from.name ?? null, email: m.from.email },
      body: m.body,
      bodyHtml: m.bodyHtml,
      isFromOwner: m.isFromOwner,
      detectedGreeting: m.detectedGreeting ?? null,
      detectedSignature: m.detectedSignature ?? null,
      strippedGreeting: m.strippedGreeting ?? null,
      strippedSignature: m.strippedSignature ?? null,
      strippedQuote: m.strippedQuote ?? null,
      sentAt: m.sentAt.toISOString(),
    })),
    attachments: conversation.attachments.map((a) => ({
      gmailMessageId: a.gmailMessageId,
      gmailAttachmentId: a.gmailAttachmentId,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    })),
    parsingProfile: senderEmail
      ? {
          senderEmail,
          useAccountParsingDefaults:
            senderParsing?.useAccountParsingDefaults ?? true,
          stripQuotedHistory:
            senderParsing?.stripQuotedHistory ??
            profileContext.parsingDefaults.stripQuotedHistory,
          stripGreeting:
            senderParsing?.stripGreeting ??
            profileContext.parsingDefaults.stripGreeting,
          stripSignature:
            senderParsing?.stripSignature ??
            profileContext.parsingDefaults.stripSignature,
          defaultStripQuotedHistory:
            profileContext.parsingDefaults.stripQuotedHistory,
          defaultStripGreeting: profileContext.parsingDefaults.stripGreeting,
          defaultStripSignature: profileContext.parsingDefaults.stripSignature,
          defaultReplyGreeting:
            profileContext.replyStyles.account.greeting ?? '',
          defaultReplySignature:
            profileContext.replyStyles.account.signature ?? '',
          replyStyleEnabled: senderStyle?.enabled ?? false,
          replyGreeting: senderStyle?.greeting ?? '',
          replySignature: senderStyle?.signature ?? '',
        }
      : null,
  }
}

/**
 * Re-run the decision layer for one thread, on demand.
 *
 * Incremental sync only revisits threads Gmail reports as changed, so a
 * conversation that was classified before Jev (or the topic LLM) was configured
 * keeps its old answer indefinitely. This runs the same pipeline a sync would,
 * over the conversation already in the database, with no Gmail round trip.
 *
 * It re-decides the owning mailbox's *own* row — the copy the merge treats as
 * canonical — rather than the merged union, so a multi-mailbox thread's extra
 * messages are never written into one account's row.
 */
export async function reanalyseConversation(
  gmailThreadId: string,
): Promise<void> {
  const cluster = await getConversationClusterByThreadId(gmailThreadId)
  if (!cluster || cluster.length === 0) {
    throw new Error('That conversation no longer exists.')
  }

  const accounts = (await listAccounts()).map((account) => ({
    id: account.id,
    email: account.email,
  }))
  const merged = mergeAccountConversations(cluster, accounts).at(0)
  if (!merged) throw new Error('That conversation no longer exists.')

  const ownerRow =
    cluster.find(
      (entry) =>
        entry.accountId === merged.ownerAccountId &&
        entry.conversation.gmailThreadId ===
          merged.conversation.gmailThreadId,
    ) ??
    cluster.find((entry) => entry.accountId === merged.ownerAccountId) ??
    cluster[0]

  await decideAndSave(ownerRow.accountId, ownerRow.conversation)
}

/**
 * In-flight syncs, keyed by account.
 *
 * Without this, a slow first backfill overlaps the next poll and runs twice
 * against the same cursor. Deduplicating here — rather than with a lock — means
 * the second caller waits for and reuses the first one's result.
 */
const inFlight = new Map<string, Promise<SyncOutcome>>()

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Sync failed for an unknown reason.'
}

/**
 * True when the failure can only be fixed by signing in to Google again.
 *
 * `GmailAuthError` covers a revoked or expired grant. The decrypt failure is
 * listed too: it means the stored token can no longer be read (a rotated
 * encryption key, say), which is just as unrecoverable without a fresh login.
 */
export function needsGoogleLogin(error: unknown): boolean {
  if (error instanceof GmailAuthError) return true
  if (error instanceof Error) {
    return (
      error.name === 'GmailAuthError' ||
      error.message.includes('could not be decrypted')
    )
  }
  return false
}

/**
 * Turn a thrown error into a failure the UI can act on.
 *
 * When Google has rejected or revoked the stored grant, the raw
 * `GmailAuthError` text describes the API rather than the fix, so it is replaced
 * with a message that names the action and a flag saying a reconnect is what
 * unblocks it. Every other failure keeps its own message and is retryable.
 *
 * Shared by the actions that talk to Gmail on demand (sending a reply, re-parsing
 * a thread) so a conversation view can offer the same reconnect path the inbox
 * does instead of only echoing an error string.
 */
export function describeActionFailure(
  error: unknown,
  fallback: string,
): ActionFailure {
  if (needsGoogleLogin(error)) {
    return {
      error:
        'Google no longer accepts the stored access — you may have revoked it, or it expired.',
      authRequired: true,
    }
  }

  return {
    error: error instanceof Error && error.message ? error.message : fallback,
    authRequired: false,
  }
}

async function runSync(
  accountId: string,
  full = false,
): Promise<SyncOutcome> {
  const existing = inFlight.get(accountId)
  if (existing) return existing

  const started = (async (): Promise<SyncOutcome> => {
    try {
      const envelope = await getAccountEnvelope(accountId)
      if (!envelope) {
        return {
          error: 'No Google account is connected.',
          authRequired: true,
        }
      }

      const gmail = await createGmailClient(envelope)
      // The account id is the email address, which is all the client wants for
      // identifying whose mailbox it is reading.
      const client = createGmailApiClient(gmail, accountId)

      await sync(client, accountId, {
        // A null cursor forces a backfill; otherwise resume incrementally.
        startHistoryId: full ? null : await getHistoryId(accountId),
        query: BACKFILL_QUERY,
        // A thread that fails to save is counted and skipped, never thrown, so
        // without this a sync that quietly drops mail looks like a clean run.
        // `message` is the underlying cause (a constraint, not the SQL).
        onProgress: (event) => {
          if (event.type === 'error') {
            console.error(
              `[sync] thread ${event.threadId} not saved: ${event.message}`,
            )
          }
        },
      })

      return { error: null, authRequired: false }
    } catch (error) {
      console.error('[sync] failed:', error)
      return {
        error: describeError(error),
        authRequired: needsGoogleLogin(error),
      }
    } finally {
      inFlight.delete(accountId)
    }
  })()

  inFlight.set(accountId, started)
  return started
}

/** One line of preview text, collapsed to something list-sized. */
function previewOf(conversation: {
  messages: Array<{ snippet: string | null; body: string }>
}): string | null {
  const last = conversation.messages.at(-1)
  if (!last) return null

  const text = (last.snippet ?? last.body).trim().replace(/\s+/g, ' ')
  if (!text) return null

  return text.length > 140 ? `${text.slice(0, 139)}…` : text
}

function toSummary(
  merged: MergedConversation,
  emailById: Map<string, string>,
): ConversationSummary {
  const conversation = merged.conversation

  return {
    id: conversation.id,
    gmailThreadId: conversation.gmailThreadId,
    subject: conversation.subject,
    state: conversation.state,
    isAutomated: conversation.isAutomated,
    replyable: conversation.replyable,
    accountId: merged.ownerAccountId,
    accountEmail: emailById.get(merged.ownerAccountId) ?? merged.ownerAccountId,
    relation: merged.relation,
    ccAccountEmails: merged.ccAccountIds.map((id) => emailById.get(id) ?? id),
    participants: conversation.participants.map((p) => ({
      name: p.name ?? null,
      email: p.email,
    })),
    messageCount: conversation.messageCount,
    attachmentCount: conversation.attachmentCount,
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    topic: conversation.topic,
    goal: conversation.goal,
    importance: conversation.importance,
    urgency: conversation.urgency,
    preview: previewOf(conversation),
  }
}

export type LoadInboxOptions = {
  /** Sync even if the cursor is fresh. */
  force?: boolean
  /**
   * Ignore the stored history cursor and rebuild from `threads.list`.
   *
   * This is what recovers mail a failed sync never persisted: incremental sync
   * only reports changes *after* the cursor, so a thread whose save failed while
   * the cursor still advanced is invisible to it forever.
   */
  full?: boolean
  staleAfterMs?: number
}

/**
 * Recompute derived conversation fields when they lag behind the code.
 *
 * Runs before the list is read, and only when the stored version is behind — so
 * it costs one extra query per load and a local recomputation once per version
 * bump. Without it, a column added today would sit at its migration default on
 * every conversation synced yesterday, and no error would ever point at why.
 */
async function ensureDerivedFields(accountId: string): Promise<void> {
  const version = await getDerivedVersion(accountId)
  if (version >= DERIVED_VERSION) return

  const updated = await backfillDerivedFields(accountId)
  // A parsing change cannot be picked up by incremental sync (Gmail only
  // revisits changed threads) and raw MIME is not stored, but the pre-strip text
  // is reconstructable from the row. Re-running the parser here is what makes a
  // detection fix apply to mail that is already in the database.
  const reparsed = await reparseStoredMessages(
    accountId,
    await getParsingProfileContext(accountId),
  )
  await setDerivedVersion(accountId, DERIVED_VERSION)

  console.log(
    `[derived] backfilled ${updated} conversations, reparsed ${reparsed} messages to v${DERIVED_VERSION}`,
  )
}

/**
 * Sync if the cursor is stale, then return the conversation list.
 *
 * A sync failure is reported rather than thrown: the conversations already in
 * the database are still worth showing, and a transient 503 should not blank the
 * inbox.
 */
export async function loadInbox(
  opts: LoadInboxOptions = {},
): Promise<InboxPayload> {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS

  const accounts = (await listAccounts()).map((account) => ({
    id: account.id,
    email: account.email,
  }))
  const emailById = new Map(
    accounts.map((account) => [account.id, account.email]),
  )

  let syncError: string | null = null
  let syncedNow = false
  let latestSyncedAt: Date | null = null
  const authRequiredAccounts: Array<{ id: string; email: string }> = []

  // Each mailbox is synced and freshness-checked on its own: one revoked grant
  // or one stale cursor must not stop the others from appearing.
  for (const account of accounts) {
    await ensureDerivedFields(account.id)

    const lastSyncedAt = await getLastSyncedAt(account.id)
    if (lastSyncedAt && (!latestSyncedAt || lastSyncedAt > latestSyncedAt)) {
      latestSyncedAt = lastSyncedAt
    }

    const isStale =
      opts.force === true || isCursorStale(lastSyncedAt, staleAfterMs)
    if (!isStale) continue

    const outcome = await runSync(account.id, opts.full === true)
    if (outcome.authRequired) authRequiredAccounts.push(account)
    if (outcome.error) {
      syncError = syncError ?? outcome.error
      continue
    }

    syncedNow = true

    const afterSync = await getLastSyncedAt(account.id)
    if (afterSync && (!latestSyncedAt || afterSync > latestSyncedAt)) {
      latestSyncedAt = afterSync
    }
  }

  // Read every mailbox, then fold them into one row per thread. The merge is
  // what collapses a conversation two of the addresses are both on, and what
  // makes "mine" mean any connected address rather than one.
  const perAccount = await Promise.all(
    accounts.map(async (account) => ({
      accountId: account.id,
      conversations: await listConversations(account.id),
    })),
  )
  const merged = mergeAccountConversations(
    perAccount.flatMap(({ accountId, conversations }) =>
      conversations.map((conversation) => ({ accountId, conversation })),
    ),
    accounts,
  )

  const counts: Record<ConversationState, number> = {
    'needs-action': 0,
    'waiting-for-reply': 0,
    informational: 0,
    'low-priority': 0,
  }
  for (const row of merged) counts[row.conversation.state] += 1

  // The list is grouped by state in the UI, but ordering within a group is by
  // activity, and the union is not sorted by construction.
  merged.sort(
    (a, b) =>
      b.conversation.lastMessageAt.getTime() -
      a.conversation.lastMessageAt.getTime(),
  )

  return {
    signedIn: true,
    accounts,
    conversations: merged.map((row) => toSummary(row, emailById)),
    counts,
    lastSyncedAt: latestSyncedAt ? latestSyncedAt.toISOString() : null,
    syncedNow,
    syncError,
    authRequiredAccounts,
  }
}
