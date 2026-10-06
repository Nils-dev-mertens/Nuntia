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
  setDerivedVersion,
} from '#/lib/auth/accounts.ts'
import { createGmailClient } from '#/lib/auth/google.ts'
import {
  backfillDerivedFields,
  DERIVED_VERSION,
  getConversation,
  getParsingProfileContext,
  listConversations,
  reparseStoredMessages,
} from '#/lib/conversation/index.ts'
import { createGmailApiClient, GmailAuthError } from './client.ts'
import { DEFAULT_STALE_AFTER_MS, isCursorStale } from './freshness.ts'
import { sync } from './sync.ts'

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
      email: string
      conversations: ConversationSummary[]
      /** Every state is present, including zeroes, so the UI can render headers. */
      counts: Record<ConversationState, number>
      /** ISO string of the last completed sync, or null if never. */
      lastSyncedAt: string | null
      /** True when this call actually talked to Gmail. */
      syncedNow: boolean
      /** Set when a sync was attempted and failed; the list is still usable. */
      syncError: string | null
      /**
       * Google rejected or revoked the stored credentials, so no sync can
       * succeed until the user signs in again. Drives the "Reconnect" action.
       */
      authRequired: boolean
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
  subject: string
  state: ConversationState
  isAutomated: boolean
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
  accountId: string,
  gmailThreadId: string,
): Promise<ConversationDetail | null> {
  const [conversation, profileContext] = await Promise.all([
    getConversation(accountId, gmailThreadId),
    getParsingProfileContext(accountId),
  ])
  if (!conversation) return null

  const otherSender = [...conversation.messages]
    .reverse()
    .find((message) => !message.isFromOwner)?.from.email
  const senderEmail = otherSender?.trim().toLowerCase() ?? null
  const senderParsing = senderEmail
    ? profileContext.parsingProfiles[senderEmail]
    : undefined
  const senderStyle = senderEmail
    ? profileContext.replyStyles.senders[senderEmail]
    : undefined

  return {
    gmailThreadId: conversation.gmailThreadId,
    subject: conversation.subject,
    state: conversation.state,
    isAutomated: conversation.isAutomated,
    topic: conversation.topic,
    goal: conversation.goal,
    awaitingReply: conversation.awaitingReply,
    participants: conversation.participants.map((p) => ({
      name: p.name ?? null,
      email: p.email,
    })),
    messages: conversation.messages.map((m) => ({
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

async function runSync(accountId: string): Promise<SyncOutcome> {
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
        startHistoryId: await getHistoryId(accountId),
        query: BACKFILL_QUERY,
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
  conversation: Awaited<ReturnType<typeof listConversations>>[number],
): ConversationSummary {
  return {
    id: conversation.id,
    gmailThreadId: conversation.gmailThreadId,
    subject: conversation.subject,
    state: conversation.state,
    isAutomated: conversation.isAutomated,
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
  accountId: string,
  opts: LoadInboxOptions = {},
): Promise<InboxPayload> {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS

  await ensureDerivedFields(accountId)

  const lastSyncedAt = await getLastSyncedAt(accountId)
  const isStale =
    opts.force === true || isCursorStale(lastSyncedAt, staleAfterMs)

  let syncError: string | null = null
  let authRequired = false
  if (isStale) {
    const outcome = await runSync(accountId)
    syncError = outcome.error
    authRequired = outcome.authRequired
  }

  const conversations = await listConversations(accountId)

  const counts: Record<ConversationState, number> = {
    'needs-action': 0,
    'waiting-for-reply': 0,
    informational: 0,
    'low-priority': 0,
  }
  for (const conversation of conversations) {
    counts[conversation.state] += 1
  }

  const syncedAt =
    syncError === null && isStale
      ? await getLastSyncedAt(accountId)
      : lastSyncedAt

  return {
    signedIn: true,
    email: accountId,
    conversations: conversations.map(toSummary),
    counts,
    lastSyncedAt: syncedAt ? syncedAt.toISOString() : null,
    syncedNow: isStale && syncError === null,
    syncError,
    authRequired,
  }
}
