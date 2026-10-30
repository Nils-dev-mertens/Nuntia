/**
 * The inbox, as the application sees it.
 *
 * Everything above this file is a library with no entry point — `sync.ts` takes
 * an injected `MailboxClient`, and nothing knows how to build one from a stored
 * account. This module is that missing seam: session account id in, list of
 * conversations out, with the staleness policy applied.
 *
 * It is deliberately the only place that knows all three of: how to authenticate
 * against a provider, when to sync, and what the UI needs.
 *
 * The `gmail/` path predates the provider seam. The code is provider-neutral now
 * — `createMailboxClientFor` picks the adapter — and the Gmail-specific name was
 * kept to avoid a second rename in the same change as the schema migration.
 *
 * Every entry point takes the signed-in user's id and scopes its work to that
 * user's mailboxes. The id comes from the session, never from the request body:
 * an account id in a payload is checked against it with `assertOwnedAccount`
 * before anything is read or written.
 */

import { readFile } from 'node:fs/promises'

import type { ConversationState } from '#/db/schema.ts'

import {
  assertOwnedAccount,
  deleteAccount,
  getCursor,
  getDerivedVersion,
  getLastSyncedAt,
  listAccounts,
  setDerivedVersion,
} from '#/lib/auth/accounts.ts'
import { isMicrosoftConfigured } from '#/lib/auth/microsoft.ts'
import {
  activeDone,
  activeImportanceOverride,
  activeStateOverride,
  backfillDerivedFields,
  DERIVED_VERSION,
  getConversationClusterByThreadId,
  getParsingProfileContext,
  getStoredAttachment,
  isSenderAddress,
  listConversations,
  markConversationSeen as applySeenMark,
  replyDraftEligibility,
  resolveReplyStyle,
  setConversationDone as applyDoneMark,
  unseenMessages,
  listIgnoredSenders,
  listUnreplyableSenders,
  normaliseEmail,
  otherPartyOf,
  partitionByState,
  recordSenderSignal,
  setAttachmentLocalPath,
  setReplyableForSender,
  setSenderReplyable,
  setImportanceOverride,
  setStateOverride,
  mergeAccountConversations,
  reparseStoredMessages,
} from '#/lib/conversation/index.ts'
import type { MailboxClient, Provider } from '#/lib/mailbox/types.ts'
import type {
  AccountConversation,
  Conversation,
  MergedConversation,
  MergeRelation,
  ReplyDraftMessage,
  ReplyDraftRequest,
} from '#/lib/conversation/index.ts'
// By path rather than through the index: this is the one entry point the AI layer
// has for recording a failure the HTTP layer cannot see, and it imports nothing
// but `node:fs`.
import { reportAiFailure } from '#/lib/ai/ai-log.ts'
import { loadReplyDrafter } from '#/lib/ai/index.ts'
import { contactNamesFor, enrichParticipants } from '#/lib/contacts/index.ts'
import {
  getContactContext,
  listContactImportanceByEmail,
} from '#/lib/contacts/context.ts'
import type { ContactContext } from '#/lib/contacts/context.ts'
import { getPreferences } from '#/lib/settings/preferences.ts'
import { ensurePushRegistrations } from '#/lib/mailbox/push.ts'
import {
  listOrganizationRules,
  listStateLabels,
} from '#/lib/organization/store.ts'
import type { StateLabels } from '#/lib/organization/labels.ts'
import { matchOrganizationRule } from '#/lib/organization/matching.ts'
import type { OrganizationRule } from '#/lib/organization/matching.ts'
import {
  downloadAttachment,
  isCached,
  removeAttachmentCache,
} from '#/lib/gmail/attachments.ts'
import { withWriteLock } from '#/lib/db/write-lock.ts'

import { GmailAuthError } from '#/lib/gmail/client.ts'
import { cursorKindFor } from '#/lib/mailbox/types.ts'
import { createMailboxClientFor } from '#/lib/mailbox/provider.ts'
import { MicrosoftAuthError } from '#/lib/microsoft/index.ts'
import { DEFAULT_STALE_AFTER_MS, isCursorStale } from './freshness.ts'
import { conversationMatchesQuery } from './search.ts'
import { findAttachmentPart } from '#/lib/mailbox/message.ts'
import {
  decideAndSave,
  redecideStoredConversations,
  sync,
} from '#/lib/mailbox/sync.ts'
import type { SyncEvent } from '#/lib/mailbox/sync.ts'

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
  providerThreadId: string
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
  /** Names filled in from stored mail, with initials and an optional avatar. */
  participants: Array<{
    name: string | null
    email: string
    initials: string
    avatarUrl: string | null
  }>
  messageCount: number
  attachmentCount: number
  /** ISO string — loader data crosses a serialization boundary. */
  lastMessageAt: string
  topic: string | null
  goal: string | null
  importance: number
  urgency: number
  /**
   * Incoming mail the user has not opened yet. Drives the unread dot, and it is
   * the *only* thing that marks a row as new: a thread they have read but not
   * answered is not new, and is not done either.
   */
  unseen: boolean
  /** Their own Done mark is live for this thread. */
  done: boolean
  /** First line of the newest message, for the list preview. */
  preview: string | null
  /** User-authored contact importance rating, when the correspondent is rated. */
  senderImportance: number | null
  /** Custom section assigned by the user's first matching organization rule. */
  organizationGroup: { id: string; name: string } | null
}

export type InboxPayload =
  | { signedIn: false; microsoftConfigured: boolean }
  | {
      signedIn: true
      /**
       * Whether Outlook (Microsoft) sign-in is available on this install. False
       * when no app registration is configured, and that is what disables the
       * Outlook buttons in the UI.
       */
      microsoftConfigured: boolean
      /** Every connected mailbox, in connection order. */
      accounts: Array<{ id: string; email: string; provider: Provider }>
      conversations: ConversationSummary[]
      /** Every state is present, including zeroes, so the UI can render headers. */
      counts: Record<ConversationState, number>
      /** Ordered user-defined rules used to create custom inbox sections. */
      organizationRules: OrganizationRule[]
      /**
       * The four state labels' names and meanings, as this user reads them.
       * Defaults where they never edited one; see `listStateLabels`.
       */
      stateLabels: StateLabels
      /** Threads the user has marked done — listed apart from the groups. */
      doneCount: number
      /** ISO string of the most recent completed sync, or null if never. */
      lastSyncedAt: string | null
      /** True when this call actually talked to any mailbox. */
      syncedNow: boolean
      /**
       * Mailboxes whose sync is still running, with the progress made so far.
       *
       * The first sync of a new mailbox is started in the background rather than
       * awaited — it is minutes of work, and holding the page open for it is what
       * made adding an account look like a hang. This is what the UI shows while
       * it runs; the poll picks the mail up as it lands.
       */
      syncing: AccountSyncProgress[]
      /** Set when a sync was attempted and failed; the list is still usable. */
      syncError: string | null
      /**
       * The mailboxes whose Google grant was rejected or revoked. Only these
       * need the "Reconnect" action — one broken mailbox must not blank the
       * others.
       */
      authRequiredAccounts: Array<{
        id: string
        email: string
        provider: Provider
      }>
    }

type SyncOutcome = { error: string | null; authRequired: boolean }

/**
 * How far one mailbox's in-progress sync has got.
 *
 * Serialisable so it can ride along on the loader payload: the first backfill of
 * a real mailbox is minutes of work, and this is the only thing the UI has to
 * show for it.
 */
export type AccountSyncProgress = {
  id: string
  email: string
  mode: 'backfill' | 'incremental'
  /** Threads finished — fetched, skipped, or failed — this run. */
  processed: number
  /** What Gmail said was ahead, once the id listing finished. Null until then. */
  estimated: number | null
}

/**
 * What an on-demand Gmail action reports back to the UI: a message to show, and
 * whether signing in to Google again is the way out.
 */
export type ActionFailure = { error: string | null; authRequired: boolean }

/** One message in the detail view. */
export type ConversationMessageView = {
  providerMessageId: string
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
  providerThreadId: string
  /** The mailbox that owns this thread — where a reply leaves from by default. */
  accountId: string
  accountEmail: string
  /** Which service this mailbox belongs to; drives the reconnect link. */
  provider: Provider
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
  /**
   * The other party's address, exactly as the replyability resolution sees it.
   *
   * Sent to the browser so a control that marks "this sender" marks the address
   * the server would resolve, rather than one the client re-derives from the
   * message list and gets subtly different.
   */
  senderEmail: string | null
  topic: string | null
  goal: string | null
  /**
   * The user's own live call on this thread's state, or null when they have
   * made none. Non-null is what the view offers "Restore" for.
   */
  stateOverride: ConversationState | null
  /** The user's own score, or null when the decision layer's stands. */
  importanceOverride: number | null
  /**
   * The other party is a sender the user has filed away before, so a one-way
   * notice from them is ranked low without being asked. Drives the same
   * "Restore" affordance, because that ranking is the app's inference and the
   * only way to disagree with it is to bring the thread back.
   */
  ignoredSender: boolean
  /**
   * The user has marked the other party as one they cannot reply to, so this
   * thread is unanswerable by their own call rather than by the marker's or
   * Jev's. The view shows the mark and offers to take it back, since it applies
   * to every future thread from that sender too.
   */
  senderUnreplyable: boolean
  /**
   * The reading mark as it stood when this page was rendered.
   *
   * Sent to the browser so the view can draw its "new messages" divider — and so
   * it can report the same instant straight back to be stored. Letting the server
   * stamp "now" on open would mark any mail that synced in between as seen, which
   * is the one thing an unread marker must never do.
   */
  seenAt: string | null
  /** The user's own Done mark is live for this thread. */
  done: boolean
  awaitingReply: boolean
  /**
   * The decision layer read a request in the newest message, so the thread asks
   * for an answer. One of the drafts gate's conditions, sent to the browser so
   * the view explains itself with the same facts the server gates on.
   */
  requiresReply: boolean
  /** 1–10, as the decision layer scored it. The other half of the drafts gate. */
  importance: number
  /**
   * Whether a reply draft can be generated for this conversation right now.
   *
   * Computed from the stored row plus the saved AI settings, so the control is
   * offered only where the server would actually generate one — and, when it is
   * not offered and a model *is* configured, `reason` says which condition
   * failed rather than leaving a missing button unexplained. Null `reason` means
   * "nothing to explain": either a draft is available, or no LLM key is stored
   * and the whole feature is off.
   */
  suggestReply: {
    available: boolean
    reason: string | null
    /** The importance the thread was compared against, 1–10. */
    minImportance: number
  }
  participants: Array<{
    name: string | null
    email: string
    initials: string
    avatarUrl: string | null
  }>
  messages: ConversationMessageView[]
  attachments: Array<{
    providerMessageId: string
    providerAttachmentId: string
    providerThreadId: string
    filename: string
    mimeType: string
    sizeBytes: number
    isInline: boolean
    sender: { name: string | null; email: string } | null
    sentAt: string | null
  }>
  contactContext: ContactContext | null
  senderImportance: number | null
  /** The user's wording for the four labels, for the badge and the picker. */
  stateLabels: StateLabels
  parsingProfile: {
    senderEmail: string
    useAccountParsingDefaults: boolean
    stripQuotedHistory: boolean
    stripGreeting: boolean
    stripSignature: boolean
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
  userId: string,
  providerThreadId: string,
): Promise<ConversationDetail | null> {
  // Resolve the *cluster*, not just the one stored conversation this thread id
  // names. A thread id is mailbox-scoped, and the mailbox it points at may hold
  // only a fragment of the conversation — Gmail does not always group a message
  // the same way in the sender's and recipient's mailboxes. The inbox merges the
  // Message-ID-connected component; the detail view must render the same one, or
  // clicking a merged row shows one account's fragment and hides the rest.
  const cluster = await getConversationClusterByThreadId(
    userId,
    providerThreadId,
  )
  if (!cluster || cluster.length === 0) return null

  const accountRows = await listAccounts(userId)
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
  // Keep a source-message lookup for sender/date details: the media list retains
  // mailbox-scoped attachment ids so it can download each candidate to hash it.
  const attachmentSourceByKey = new Map<
    string,
    {
      sender: { name: string | null; email: string } | null
      sentAt: string | null
    }
  >()
  for (const source of cluster) {
    for (const attachment of source.conversation.attachments) {
      const key = `${source.conversation.providerThreadId}:${attachment.providerMessageId}:${attachment.providerAttachmentId}`
      const sourceMessage = source.conversation.messages.find(
        (message) => message.providerMessageId === attachment.providerMessageId,
      )
      attachmentSourceByKey.set(key, {
        sender: sourceMessage
          ? {
              name: sourceMessage.from.name ?? null,
              email: sourceMessage.from.email,
            }
          : null,
        sentAt: sourceMessage?.sentAt.toISOString() ?? null,
      })
    }
  }

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
  const contactContext = senderEmail
    ? await getContactContext(userId, senderEmail)
    : null
  const senderParsing = senderEmail
    ? profileContext.parsingProfiles[senderEmail]
    : undefined
  const senderStyle = senderEmail
    ? profileContext.replyStyles.senders[senderEmail]
    : undefined

  const ignoredSenders = await listIgnoredSenders(accountId)
  const unreplyableSenders = await listUnreplyableSenders(accountId)

  // One read of the AI settings row, for the two things the drafts gate needs:
  // whether a model is configured at all, and the importance threshold. Read
  // here rather than re-derived in the browser so the explanation on screen and
  // the guard in `draftReply` cannot disagree.
  const drafting = await loadReplyDrafter(userId)
  const draftEligibility = replyDraftEligibility({
    modelConfigured: drafting.drafter !== null,
    replyable: conversation.replyable,
    awaitingReply: conversation.awaitingReply,
    importance: conversation.importance,
    minImportance: drafting.minImportance,
  })

  // Names learned from earlier mail, and whether avatars may leave the machine.
  // Read once for the whole thread rather than per participant.
  const names = await contactNamesFor(accountRows.map((account) => account.id))
  const preferences = await getPreferences(userId)
  // The user's wording for the label on the badge and in the picker.
  const stateLabels = await listStateLabels(userId)

  return {
    providerThreadId: conversation.providerThreadId,
    accountId,
    accountEmail:
      accounts.find((account) => account.id === accountId)?.email ?? accountId,
    provider:
      accountRows.find((account) => account.id === accountId)?.provider ??
      'google',
    replyAccounts,
    ownerEmails: [...owners],
    subject: conversation.subject,
    state: conversation.state,
    isAutomated: conversation.isAutomated,
    replyable: conversation.replyable,
    senderEmail,
    topic: conversation.topic,
    goal: conversation.goal,
    stateOverride: activeStateOverride(conversation),
    importanceOverride: activeImportanceOverride(conversation),
    seenAt: conversation.seenAt?.toISOString() ?? null,
    done: activeDone(conversation) !== null,
    ignoredSender: senderEmail ? ignoredSenders.has(senderEmail) : false,
    senderUnreplyable: senderEmail
      ? unreplyableSenders.has(senderEmail)
      : false,
    awaitingReply: conversation.awaitingReply,
    requiresReply: conversation.requiresReply,
    importance: conversation.importance,
    suggestReply: {
      available: draftEligibility.eligible,
      // Only explained when there is a model to explain it about: an install with
      // no key has drafts switched off, not a thread that missed a condition.
      reason:
        !draftEligibility.eligible && drafting.drafter !== null
          ? draftEligibility.detail
          : null,
      minImportance: drafting.minImportance,
    },
    participants: enrichParticipants(
      conversation.participants,
      names,
      preferences.useGravatar,
    ),
    messages: messages.map((m) => ({
      providerMessageId: m.providerMessageId,
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
    attachments: conversation.attachments.map((a) => {
      const sourceThreadId = a.providerThreadId ?? conversation.providerThreadId
      const details = attachmentSourceByKey.get(
        `${sourceThreadId}:${a.providerMessageId}:${a.providerAttachmentId}`,
      )
      return {
        providerMessageId: a.providerMessageId,
        providerAttachmentId: a.providerAttachmentId,
        providerThreadId: sourceThreadId,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        isInline: a.isInline,
        sender: details?.sender ?? null,
        sentAt: details?.sentAt ?? null,
      }
    }),
    contactContext,
    senderImportance: contactContext?.importance ?? null,
    stateLabels,
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
 * Disconnect a mailbox and delete everything synced from it.
 *
 * The mail itself stays in Gmail, so this is a way to start over rather than a
 * way to lose anything: connect the mailbox again and it syncs fresh. That is
 * worth having as an action, because a library synced by an older version keeps
 * that version's parsing — the fix is applied when a message is parsed, not to
 * rows already written, so the honest way to see what the current code produces
 * is to clear it out and sync again.
 *
 * Rows first, cached files second: an interrupted purge leaves a database that is
 * already consistent, where the reverse would leave rows pointing at files that
 * no longer exist. Deleting the account cascades to its conversations, messages,
 * attachments, decisions and history cursor (every one is declared `onDelete:
 * 'cascade'`), so nothing else has to be listed here.
 */
export async function forgetAccount(
  userId: string,
  accountId: string,
): Promise<void> {
  await assertOwnedAccount(userId, accountId)

  await withWriteLock(async () => {
    await deleteAccount(userId, accountId)
  })

  await removeAttachmentCache(accountId)
}

/** The bytes of one attachment, with the metadata needed to describe them. */
export type AttachmentFile = {
  filename: string
  mimeType: string
  isInline: boolean
  bytes: Buffer
}

export type AttachmentLoad =
  | { ok: true; file: AttachmentFile }
  | { ok: false; reason: 'not-found' | 'too-large' | 'not-connected' }

/**
 * Load one attachment's bytes, downloading them on first request.
 *
 * Deliberately not part of sync: `format: 'full'` carries attachment metadata
 * only, and fetching every file for every synced thread would pull down mail the
 * user never opens. The first time someone opens a chip is what fetches it, and
 * the copy on disk is what every click after that uses.
 */
export async function loadAttachment(
  userId: string,
  providerThreadId: string,
  providerAttachmentId: string,
  /**
   * The Gmail client to fetch with.
   *
   * Production omits it and the mailbox is resolved from the stored account, the
   * same way sync does. It exists so the download-and-cache path can be driven
   * against the fake client instead of a real mailbox.
   */
  deps: { client?: MailboxClient } = {},
): Promise<AttachmentLoad> {
  const stored = await getStoredAttachment(
    userId,
    providerThreadId,
    providerAttachmentId,
  )
  if (!stored) return { ok: false, reason: 'not-found' }

  let path: string | null = stored.localPath
  if (!path || !(await isCached(path))) {
    let client = deps.client

    if (!client) {
      const resolved = await createMailboxClientFor(stored.accountId)
      if (!resolved) return { ok: false, reason: 'not-connected' }
      client = resolved
    }

    const thread = await client.getThread(stored.providerThreadId)

    // `getAttachment` addresses a message by Gmail's *own* message id, and the
    // message row is keyed by the RFC 5322 Message-ID instead — so the two ids
    // the download needs are only together in the thread payload. One extra
    // request, once, for a file the user asked to see.
    //
    // Matched on the part's traits rather than the stored attachment id, which
    // Gmail is free to have changed since the sync that recorded it.
    const part = findAttachmentPart(thread.messages, stored)
    if (!part) return { ok: false, reason: 'not-found' }

    const result = await downloadAttachment(
      client,
      stored.accountId,
      part.messageId,
      part.ref,
    )

    if (result.status === 'missing') return { ok: false, reason: 'not-found' }
    if (result.status === 'skipped') return { ok: false, reason: 'too-large' }

    path = result.path
    // Recorded here rather than at sync time: the row exists from the beginning
    // and the file only appears when someone opens it.
    await setAttachmentLocalPath(stored.id, path)
  }

  return {
    ok: true,
    file: {
      filename: stored.filename,
      mimeType: stored.mimeType,
      isInline: stored.isInline,
      bytes: await readFile(path),
    },
  }
}

/**
 * The owning mailbox's row for a thread id, resolved the way every action does.
 *
 * A thread can live in more than one connected mailbox, and the merge treats one
 * row as canonical — the owner's. Everything the user does to a thread lands on
 * that row: a state call, reading it, finishing it, re-deciding it. Writing to
 * whichever copy the cluster happened to list first is how one mailbox's row ends
 * up holding another's messages, so the resolution lives here once rather than
 * being re-derived by each caller.
 */
async function ownerRowForThread(
  userId: string,
  providerThreadId: string,
): Promise<{
  cluster: AccountConversation[]
  merged: MergedConversation
  accountId: string
  conversation: Conversation
}> {
  const cluster = await getConversationClusterByThreadId(
    userId,
    providerThreadId,
  )
  if (!cluster || cluster.length === 0) {
    throw new Error('That conversation no longer exists.')
  }

  const accounts = (await listAccounts(userId)).map((account) => ({
    id: account.id,
    email: account.email,
    provider: account.provider,
  }))
  const merged = mergeAccountConversations(cluster, accounts).at(0)
  if (!merged) throw new Error('That conversation no longer exists.')

  const ownerRow =
    cluster.find(
      (entry) =>
        entry.accountId === merged.ownerAccountId &&
        entry.conversation.providerThreadId ===
          merged.conversation.providerThreadId,
    ) ??
    cluster.find((entry) => entry.accountId === merged.ownerAccountId) ??
    cluster[0]

  return {
    cluster,
    merged,
    accountId: ownerRow.accountId,
    conversation: ownerRow.conversation,
  }
}

/**
 * Note that the user has opened this thread, up to a given message.
 *
 * This is what makes a thread stop looking new, and it is deliberately all it
 * does: the state and the Done mark are untouched, so reading mail can never be
 * mistaken for having dealt with it. The instant comes from the view, which is
 * the only thing that knows what the user actually had on screen — the row's
 * newest message may include mail that synced in after the page was rendered.
 */
export async function markConversationSeen(
  userId: string,
  providerThreadId: string,
  seenThrough: string,
): Promise<void> {
  const at = new Date(seenThrough)
  // A time that does not parse is refused rather than guessed at: the fallback
  // would be the row's newest message, which is precisely the mail the user may
  // not have seen.
  if (Number.isNaN(at.getTime())) {
    throw new Error('That is not a valid time.')
  }

  const { accountId, conversation } = await ownerRowForThread(
    userId,
    providerThreadId,
  )
  await applySeenMark(accountId, conversation.providerThreadId, at)
}

/**
 * Mark a thread's other party as a sender a reply cannot reach.
 *
 * The one-click half of the can't-reply list, and the reason it takes a *thread*
 * rather than an address: this is the direction the user is looking at when they
 * decide it, so the mailbox and the address are both resolved here rather than
 * typed into a form. It lands on exactly what `addUnreplyableSender` writes — the
 * sender-level mark plus the sweep of every stored thread from them — so a mark
 * made from a thread and one made from Settings are the same mark, and either can
 * be taken back from the one list.
 *
 * The address is `otherPartyOf`'s answer, the same resolution the sweep and the
 * decision path use, and it is taken from the *merged* thread so a thread between
 * two of the user's own mailboxes is not mistaken for a correspondent.
 *
 * Refused when there is no one on the other side. A thread made only of the
 * user's own messages has no sender to mark, and writing the owner's own address
 * here would hide the composer on the user's own mail.
 */
export async function markThreadSenderUnreplyable(
  userId: string,
  providerThreadId: string,
): Promise<{ error: string | null }> {
  const { accountId, merged } = await ownerRowForThread(
    userId,
    providerThreadId,
  )
  const senderEmail = otherPartyOf(merged.conversation)

  if (!senderEmail) {
    return { error: 'This conversation has no sender to mark.' }
  }

  await applySenderReplyabilityToSender(userId, accountId, senderEmail, false)
  return { error: null }
}

/**
 * What one draft request reports back: the text, or why there is none.
 *
 * A union rather than a nullable string, because "no draft" always has a reason
 * worth showing and the two failure shapes are different: a condition that is
 * not met is a statement about the thread, while a model that failed is an error.
 */
export type ReplyDraftOutcome =
  { draft: string; error: null } | { draft: null; error: string }

/**
 * Generate a draft reply for one conversation, on demand.
 *
 * Deliberately *not* part of the decision pipeline: the pipeline runs on every
 * sync for every thread, and a draft costs a paid API call. This is generated
 * when the user asks for one, for the thread they are looking at.
 *
 * The gate is re-applied here from the stored row rather than trusted from the
 * caller. The view decides whether to *offer* the control from the same facts,
 * but mail arrives between a page render and a click, and a stale button must
 * not be able to spend a call on a thread that no longer qualifies.
 *
 * The result is text. Nothing here sends, and nothing here writes to the
 * database — the draft exists in the composer until the user sends it, which is
 * the only thing that sends.
 */
export async function draftReply(
  userId: string,
  providerThreadId: string,
  instructions: string | null,
): Promise<ReplyDraftOutcome> {
  const detail = await loadConversation(userId, providerThreadId)
  if (!detail) {
    return { draft: null, error: 'That conversation no longer exists.' }
  }

  const { drafter, minImportance } = await loadReplyDrafter(userId)

  const eligibility = replyDraftEligibility({
    modelConfigured: drafter !== null,
    replyable: detail.replyable,
    awaitingReply: detail.awaitingReply,
    importance: detail.importance,
    minImportance,
  })

  if (!eligibility.eligible) {
    return { draft: null, error: eligibility.detail }
  }

  // Non-null once the gate passed, since `no-model` is the gate's first check.
  if (!drafter) {
    return { draft: null, error: 'No LLM key is configured.' }
  }

  try {
    const draft = await drafter.draft(
      replyDraftRequestFor(detail, instructions?.trim() || null),
    )

    if (!draft) {
      // A 200 with nothing usable in it leaves no other trace: the transport
      // logged the call as fine, so this is the only record that it produced no
      // reply the user could use.
      await reportAiFailure(
        drafter.name,
        new Error('the model returned nothing usable'),
        'drafted nothing',
      )
      return {
        draft: null,
        error:
          'The model returned nothing usable. Try again, or a different model.',
      }
    }

    return { draft, error: null }
  } catch (error) {
    console.error('[draft] generating a reply failed:', error)
    const reason = error instanceof Error ? error.message : String(error)
    await reportAiFailure(drafter.name, error, 'failed to draft a reply')
    return { draft: null, error: `Could not draft a reply. ${reason}` }
  }
}

/** What a goal check has to say about a reply the user already sent. */
export type ReplyGoalCheck = {
  /** What the reply is missing, in the user's terms. */
  reason: string | null
  /** A replacement body, when the model wrote one. */
  suggestion: string | null
}

/**
 * Judge a reply the user just sent against the thread's goal.
 *
 * Null when there is nothing to judge: a thread without a goal has no standard to
 * miss, and an install without an LLM has nobody to ask. Best-effort by design —
 * this runs after a send that already succeeded, so a failure here is reported as
 * advice that could not be produced, never as a failed send.
 */
export async function reviewSentReply(
  userId: string,
  providerThreadId: string,
  sentBody: string,
): Promise<{ check: ReplyGoalCheck | null; error: string | null }> {
  const detail = await loadConversation(userId, providerThreadId)
  if (!detail?.goal) return { check: null, error: null }

  const { reviewer } = await loadReplyDrafter(userId)
  if (!reviewer) return { check: null, error: null }

  const owners = new Set(
    detail.ownerEmails.map((email) => email.trim().toLowerCase()),
  )
  const incoming = [...detail.messages]
    .reverse()
    .find((message) => !owners.has(message.from.email.trim().toLowerCase()))

  try {
    const verdict = await reviewer.review({
      goal: detail.goal,
      topic: detail.topic,
      incoming: incoming?.body ?? null,
      sentReply: sentBody,
    })

    if (!verdict) {
      return {
        check: null,
        error: 'Could not check that reply against your goal.',
      }
    }
    if (verdict.meetsGoal) return { check: null, error: null }

    return {
      check: { reason: verdict.reason, suggestion: verdict.suggestion },
      error: null,
    }
  } catch (error) {
    console.error('[goal] checking the sent reply failed:', error)
    await reportAiFailure(
      reviewer.name,
      error,
      'failed to check a reply against the goal',
    )
    return {
      check: null,
      error: 'Could not check that reply against your goal.',
    }
  }
}

/**
 * Everything the model is given, assembled from the loaded view.
 *
 * Built from the *detail* payload rather than a fresh read of the row, so a draft
 * describes exactly the thread on screen: the same merge, the same messages, the
 * same order. The greeting and signature are resolved with the same function the
 * send path uses, because the prompt's "do not write one" and the sanitiser's
 * "drop the one you wrote" are both only true if the send really does add one.
 */
function replyDraftRequestFor(
  detail: ConversationDetail,
  instructions: string | null,
): ReplyDraftRequest {
  const owners = new Set(
    detail.ownerEmails.map((email) => email.trim().toLowerCase()),
  )

  const incoming = [...detail.messages]
    .reverse()
    .find((message) => !owners.has(message.from.email.trim().toLowerCase()))

  const lastOwnerMessage = [...detail.messages]
    .reverse()
    .find((message) => message.isFromOwner)

  const style = resolveReplyStyle({
    account: {
      greeting: detail.parsingProfile?.defaultReplyGreeting || null,
      signature: detail.parsingProfile?.defaultReplySignature || null,
    },
    sender: detail.parsingProfile
      ? {
          enabled: detail.parsingProfile.replyStyleEnabled,
          greeting: detail.parsingProfile.replyGreeting || null,
          signature: detail.parsingProfile.replySignature || null,
        }
      : null,
    // The `detected_*` pair is the one the parser always fills in, whether or not
    // the text was actually stripped from the stored body.
    lastOwnerMessage: lastOwnerMessage
      ? {
          detectedGreeting: lastOwnerMessage.detectedGreeting,
          detectedSignature: lastOwnerMessage.detectedSignature,
        }
      : null,
  })

  const messages: ReplyDraftMessage[] = detail.messages.map((message) => ({
    speaker: message.from.name ?? message.from.email,
    isFromOwner: message.isFromOwner,
    sentAt: message.sentAt,
    body: message.body,
  }))

  return {
    subject: detail.subject,
    topic: detail.topic,
    goal: detail.goal,
    recipient: incoming
      ? { name: incoming.from.name, email: incoming.from.email }
      : null,
    ownerEmail: detail.accountEmail,
    messages,
    greeting: style.greeting,
    signature: style.signature,
    instructions,
  }
}

/**
 * Mark a thread done, or take the mark back.
 *
 * The user's own call, and the only thing that sets it: not a sync, not the
 * decision layer, and not opening the thread. That is the point of it — a thread
 * the user has read but not answered keeps looking like work, which is what stops
 * a reply from being forgotten.
 *
 * Nothing else changes. The state stays where the decision layer put it, exactly
 * as with the can't-reply mark, because "handled" is not a claim about what the
 * mail needs. No Gmail call and no AI call, so there is no auth failure to report.
 */
export async function setConversationDone(
  userId: string,
  providerThreadId: string,
  done: boolean,
): Promise<void> {
  const { accountId, conversation } = await ownerRowForThread(
    userId,
    providerThreadId,
  )
  await applyDoneMark(accountId, conversation.providerThreadId, done)
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
  userId: string,
  providerThreadId: string,
): Promise<void> {
  const { accountId, conversation } = await ownerRowForThread(
    userId,
    providerThreadId,
  )

  await decideAndSave(accountId, conversation, { userId })
}

/**
 * Label a conversation, or hand it back to the app.
 *
 * Two things happen, and both are needed for the call to stick:
 *
 * 1. The label is stored on the row. Every later re-decide — a sync, a version
 *    bump, a manual re-analyse — rebuilds the thread from Gmail and would
 *    otherwise reach its own conclusion, so the user's answer has to live
 *    somewhere the decision path reads. Any of the four is set this way, which is
 *    the point of a picker: "Needs action" is as legitimate a correction as
 *    "Low priority".
 * 2. *Low priority* is remembered about the **sender** as well, because the mail
 *    that call is aimed at arrives the same way every time: a one-off notice from
 *    a website that means nothing and asks nothing. Filing one away should be
 *    enough to stop the next one being filed as work. No other label teaches that
 *    lesson — labelling one thread "Needs action" says the opposite about the
 *    sender's mail in general, and must not quietly rank the rest of it low.
 *
 * Handing the thread back (`state: null`) clears the stored label and switches
 * that sender's learning off until they file something away again, then re-runs
 * the pipeline so the thread lands where it would have without them ever having
 * said anything. Storing the label is cheap; undoing it is the case that needs a
 * decision, and it is the case the user is watching.
 */
export async function applyUserStateOverride(
  userId: string,
  providerThreadId: string,
  state: ConversationState | null,
): Promise<void> {
  const { merged, accountId, conversation } = await ownerRowForThread(
    userId,
    providerThreadId,
  )
  const sender = [...conversation.messages]
    .reverse()
    .find((message) => !message.isFromOwner)?.from.email

  if (state === null) {
    if (sender) await recordSenderSignal(accountId, sender, 'restored')
    await setStateOverride(accountId, conversation.providerThreadId, null)
    await decideAndSave(accountId, conversation, { userId })
    return
  }

  await setStateOverride(accountId, conversation.providerThreadId, {
    state,
    // Against the thread as the *merged* view has it, which is what the user was
    // looking at when they picked, and which is the same clock a later sync
    // compares against.
    messageAt: merged.conversation.lastMessageAt,
  })

  // The sender-level lesson, and only for the label that means it. This used to
  // run for whatever the button sent, because the only buttons were "Not
  // important" and "Restore"; with a picker, teaching it from "Needs action"
  // would rank that sender's mail low to cancel out the label just set.
  if (sender && state === 'low-priority') {
    await recordSenderSignal(accountId, sender, 'ignored')
  }
}

/**
 * Set the user's own importance score for a conversation, or hand it back.
 *
 * Stored against the thread as the *merged* view has it, because that is what the
 * user was looking at when they picked, and it is the same clock a later sync
 * compares against. Handing it back re-runs the decision layer, which is the only
 * thing that can say what the score would have been without them.
 *
 * Nothing else changes: importance is not the user's answer about whether a
 * thread is handled, and it does not move the label.
 */
export async function applyUserImportanceOverride(
  userId: string,
  providerThreadId: string,
  importance: number | null,
): Promise<void> {
  const { merged, accountId, conversation } = await ownerRowForThread(
    userId,
    providerThreadId,
  )

  if (importance === null) {
    await setImportanceOverride(accountId, conversation.providerThreadId, null)
    await decideAndSave(accountId, conversation, { userId })
    return
  }

  await setImportanceOverride(accountId, conversation.providerThreadId, {
    importance,
    messageAt: merged.conversation.lastMessageAt,
  })
}

/**
 * Record the user's own answer about whether a sender can be replied to.
 *
 * Two writes, and both are needed:
 *
 * 1. The answer is stored per *sender*, because that is what the user was
 *    answering — this company's mail is view-only, not just this one thread. New
 *    mail from them, and anything re-decided, then reads it back from the
 *    decision path rather than re-inferring it.
 * 2. Every thread already stored from that sender is updated in place. The
 *    decision layer only runs on threads Gmail reports as changed, so without
 *    the sweep the threads stored before the mark would keep their composer until
 *    the next sync — and the entry would look like it did nothing.
 *
 * The state is deliberately left alone. The user is saying they cannot answer
 * this sender, not that the thread does not matter, so it stays where they found
 * it and the inbox keeps listing it.
 *
 * The sender arrives as an address rather than being resolved from a thread,
 * because the list is managed in Settings and has to be able to name a sender
 * before any mail from them has arrived. Both directions go through this one
 * function, so a mark added in the list and a mark lifted from it do the
 * identical pair of writes.
 */
export async function applySenderReplyabilityToSender(
  userId: string,
  accountId: string,
  senderEmail: string,
  replyable: boolean,
): Promise<void> {
  await assertOwnedAccount(userId, accountId)
  await setSenderReplyable(accountId, senderEmail, replyable)
  await setReplyableForSender(accountId, senderEmail, replyable)
}

/**
 * Add an address to the can't-reply list, as the settings form does.
 *
 * The list is the only way to mark a sender, and it is typed rather than picked
 * from a thread, so nothing about the input is trusted or assumed: the mailbox has
 * to be one of the connected ones, the address has to look like an address, and
 * the mailbox's own address is refused — a rule there would hide the composer on
 * the user's own mail if it ever came back round.
 *
 * An address with no stored threads is accepted on purpose, which is the reason
 * the list is managed here rather than from a thread: it can answer for a sender
 * before their next notice arrives, and the stored profile row is what the
 * decision path reads when the first thread does.
 *
 * Returns the address **as stored** (normalised) so the caller confirms the entry
 * the list actually holds, or the reason it was refused.
 */
export async function addUnreplyableSender(
  userId: string,
  accountId: string,
  rawAddress: string,
): Promise<{ added: string | null; error: string | null }> {
  // `mailbox` rather than reusing the parameter name: the normalised form is what
  // every call below needs, and shadowing is how the raw one gets passed by
  // accident.
  const mailbox = accountId.trim().toLowerCase()
  const account = (await listAccounts(userId)).find(
    (candidate) => candidate.id === mailbox,
  )
  if (!account) {
    return { added: null, error: 'That mailbox is not connected.' }
  }

  const senderEmail = normaliseEmail(rawAddress)
  if (!isSenderAddress(senderEmail)) {
    return { added: null, error: 'That does not look like an email address.' }
  }

  if (senderEmail === normaliseEmail(account.email)) {
    return {
      added: null,
      error: `${senderEmail} is this mailbox's own address.`,
    }
  }

  // Read from storage rather than from whatever list the page was rendered with:
  // a second tab may have added this sender since, and reporting "added" twice
  // would be the one confirmation the list cannot back up.
  if ((await listUnreplyableSenders(mailbox)).has(senderEmail)) {
    return { added: null, error: `${senderEmail} is already on the list.` }
  }

  await applySenderReplyabilityToSender(userId, mailbox, senderEmail, false)
  return { added: senderEmail, error: null }
}

/**
 * Take an address off the can't-reply list.
 *
 * Only an entry that is actually there can be lifted, checked against storage
 * rather than the rendered list, so a stale tab cannot claim to have undone a mark
 * made since. The address is not shape-checked: it has to be on the list already,
 * which is a stronger statement than any shape rule.
 */
export async function removeUnreplyableSender(
  userId: string,
  accountId: string,
  rawAddress: string,
): Promise<{ error: string | null }> {
  const mailbox = accountId.trim().toLowerCase()
  const connected = await listAccounts(userId)
  if (!connected.some((candidate) => candidate.id === mailbox)) {
    return { error: 'That mailbox is not connected.' }
  }

  const senderEmail = normaliseEmail(rawAddress)
  if (!(await listUnreplyableSenders(mailbox)).has(senderEmail)) {
    return { error: 'That sender is not marked as one you cannot reply to.' }
  }

  await applySenderReplyabilityToSender(userId, mailbox, senderEmail, true)
  return { error: null }
}

/**
 * In-flight syncs, keyed by account.
 *
 * Without this, a slow first backfill overlaps the next poll and runs twice
 * against the same cursor. Deduplicating here — rather than with a lock — means
 * the second caller waits for and reuses the first one's result.
 */
const inFlight = new Map<string, Promise<SyncOutcome>>()

/**
 * Live progress for the syncs currently running, keyed by account.
 *
 * Process-local, like `inFlight`, and for the same reason: the app is local-first
 * and single-user, so "the sync this install is running" and "the sync this
 * process is running" are the same thing. `loadInbox` reads it to tell the page
 * what a background run is doing rather than holding the request open for it.
 */
const syncProgress = new Map<
  string,
  Omit<AccountSyncProgress, 'id'> & { startedAt: number }
>()

/**
 * The result of each account's most recent attempt, kept after the run ends.
 *
 * A first sync is started in the background, so its failure has no `await` to
 * surface it on. The outcome outlives the run precisely so the next load can
 * report why the inbox is still empty instead of showing a spinner forever.
 */
const lastOutcome = new Map<string, SyncOutcome>()

/**
 * Fold one sync event into an account's progress entry.
 *
 * `start` corrects the mode guessed from the cursor (a null one backfills even
 * when no `full` was asked for), `listed` supplies the total, and the three
 * per-thread events all count as one thread done — a skipped or failed thread is
 * still work finished, so the counter tracks the run rather than only its wins.
 */
function trackProgress(accountId: string, event: SyncEvent): void {
  const entry = syncProgress.get(accountId)
  if (!entry) return

  switch (event.type) {
    case 'start':
      entry.mode = event.mode
      break
    case 'listed':
      entry.estimated = event.total
      break
    case 'thread':
    case 'skipped':
    case 'error':
      entry.processed += 1
      break
    case 'done':
      break
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Sync failed for an unknown reason.'
}

/**
 * True when the failure can only be fixed by signing in to the provider again.
 *
 * `GmailAuthError` and `MicrosoftAuthError` cover a revoked or expired grant —
 * one per adapter, both meaning the same thing here. The decrypt failure is
 * listed too: it means the stored token can no longer be read (a rotated
 * encryption key, say), which is just as unrecoverable without a fresh login.
 */
export function needsReconnect(error: unknown): boolean {
  if (error instanceof GmailAuthError || error instanceof MicrosoftAuthError) {
    return true
  }
  if (error instanceof Error) {
    return (
      error.name === 'GmailAuthError' ||
      error.name === 'MicrosoftAuthError' ||
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
  if (needsReconnect(error)) {
    return {
      error:
        'The mailbox no longer accepts the stored access — you may have revoked it, or it expired.',
      authRequired: true,
    }
  }

  return {
    error: error instanceof Error && error.message ? error.message : fallback,
    authRequired: false,
  }
}

async function runSync(
  userId: string,
  accountId: string,
  full = false,
  email = accountId,
): Promise<SyncOutcome> {
  const existing = inFlight.get(accountId)
  if (existing) return existing

  // A fresh attempt supersedes whatever the last one said, so a failure that is
  // already being retried does not keep showing as the current state.
  lastOutcome.delete(accountId)
  // Published synchronously, before the run's first `await`, so a caller that
  // fires this off without awaiting can still see the run it just started.
  syncProgress.set(accountId, {
    email,
    mode: full ? 'backfill' : 'incremental',
    processed: 0,
    estimated: null,
    startedAt: Date.now(),
  })

  const started = (async (): Promise<SyncOutcome> => {
    try {
      const client = await createMailboxClientFor(accountId)
      if (!client) {
        return {
          error: 'No mailbox is connected.',
          authRequired: true,
        }
      }

      await sync(client, accountId, {
        userId,
        // A null cursor forces a backfill; otherwise resume incrementally.
        startHistoryId: full
          ? null
          : await getCursor(accountId, cursorKindFor(client.provider)),
        // Only Gmail understands its search syntax; Graph's adapter applies its
        // own backfill window inside `listThreads`.
        query: client.provider === 'google' ? BACKFILL_QUERY : undefined,
        // A thread that fails to save is counted and skipped, never thrown, so
        // without this a sync that quietly drops mail looks like a clean run.
        // `message` is the underlying cause (a constraint, not the SQL).
        onProgress: (event) => {
          trackProgress(accountId, event)
          if (event.type === 'error') {
            console.error(
              `[sync] thread ${event.threadId} not saved: ${event.message}`,
            )
          }
        },
      })

      const outcome: SyncOutcome = { error: null, authRequired: false }
      lastOutcome.set(accountId, outcome)
      return outcome
    } catch (error) {
      console.error('[sync] failed:', error)
      const outcome: SyncOutcome = {
        error: describeError(error),
        authRequired: needsReconnect(error),
      }
      lastOutcome.set(accountId, outcome)
      return outcome
    } finally {
      inFlight.delete(accountId)
      syncProgress.delete(accountId)
    }
  })()

  inFlight.set(accountId, started)
  return started
}

/**
 * Start an incremental sync for one mailbox, without waiting for it.
 *
 * Used by the push webhook: Pub/Sub has to be answered quickly, and the same
 * `inFlight` map that deduplicates polls covers overlapping notifications, so a
 * burst of messages costs one sync rather than one each.
 */
export function startBackgroundSync(
  userId: string,
  accountId: string,
  email: string,
): void {
  void runSync(userId, accountId, false, email)
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
  names: Map<string, string>,
  useGravatar: boolean,
  organizationRules: OrganizationRule[],
  contactImportance: ReadonlyMap<string, number>,
): ConversationSummary {
  const conversation = merged.conversation

  const matchedRule = matchOrganizationRule(
    {
      senderEmail: otherPartyOf(conversation),
      subject: conversation.subject,
      topic: conversation.topic,
      state: conversation.state,
    },
    organizationRules,
  )

  return {
    id: conversation.id,
    providerThreadId: conversation.providerThreadId,
    subject: conversation.subject,
    state: conversation.state,
    isAutomated: conversation.isAutomated,
    replyable: conversation.replyable,
    accountId: merged.ownerAccountId,
    accountEmail: emailById.get(merged.ownerAccountId) ?? merged.ownerAccountId,
    relation: merged.relation,
    ccAccountEmails: merged.ccAccountIds.map((id) => emailById.get(id) ?? id),
    participants: enrichParticipants(
      conversation.participants,
      names,
      useGravatar,
    ),
    messageCount: conversation.messageCount,
    attachmentCount: conversation.attachmentCount,
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    topic: conversation.topic,
    goal: conversation.goal,
    importance: conversation.importance,
    urgency: conversation.urgency,
    unseen: unseenMessages(conversation).length > 0,
    done: activeDone(conversation) !== null,
    preview: previewOf(conversation),
    senderImportance: contactImportance.get(otherPartyOf(conversation)) ?? null,
    organizationGroup: matchedRule
      ? { id: matchedRule.id, name: matchedRule.name }
      : null,
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
  /**
   * Match stored mail instead of loading everything.
   *
   * A search reads what the last sync wrote and never talks to the provider, so
   * typing in the search box cannot turn into a mailbox round trip. Archived
   * threads are included: they are synced mail, and a search is exactly where
   * one should be findable again.
   */
  search?: string
}

/**
 * Recompute derived conversation fields when they lag behind the code.
 *
 * Runs before the list is read, and only when the stored version is behind — so
 * it costs one extra query per load and a local recomputation once per version
 * bump. Without it, a column added today would sit at its migration default on
 * every conversation synced yesterday, and no error would ever point at why.
 */
async function ensureDerivedFields(
  userId: string,
  accountId: string,
): Promise<void> {
  const version = await getDerivedVersion(accountId)
  if (version >= DERIVED_VERSION) return

  // Replyability is part user-owned now, so the column backfill is handed the
  // senders the user has marked: without them it would reset `replyable` to
  // `!isAutomated` on every thread of a marked sender.
  const updated = await backfillDerivedFields(
    accountId,
    await listUnreplyableSenders(accountId),
  )
  // A parsing change cannot be picked up by incremental sync (the provider only
  // revisits changed threads). Re-running over retained original bodies also
  // makes detection fixes apply to already-stored mail.
  const reparsed = await reparseStoredMessages(
    accountId,
    await getParsingProfileContext(accountId),
  )
  // The same argument one layer up: `backfillDerivedFields` recomputes the
  // columns it can, but `state`, `importance` and `urgency` are decisions, and a
  // decision change only lands when the thread is re-decided. Without this, a
  // classifier change would reach only mail Gmail reports as changed afterwards.
  const redecided = await redecideStoredConversations(accountId, userId)
  await setDerivedVersion(accountId, DERIVED_VERSION)

  console.log(
    `[derived] backfilled ${updated} conversations, reparsed ${reparsed} messages, re-decided ${redecided} to v${DERIVED_VERSION}`,
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
  userId: string,
  opts: LoadInboxOptions = {},
): Promise<InboxPayload> {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  // Trimmed once here: an all-whitespace query is not a search, and every branch
  // below has to agree about that.
  const search = opts.search?.trim() ?? ''

  const accounts = (await listAccounts(userId)).map((account) => ({
    id: account.id,
    email: account.email,
    provider: account.provider,
  }))
  const emailById = new Map(
    accounts.map((account) => [account.id, account.email]),
  )

  // One read for every mailbox, and the avatar setting for this user. A thread
  // whose newest message has no display name still shows the person's name.
  const names = await contactNamesFor(accounts.map((account) => account.id))
  const preferences = await getPreferences(userId)

  // Push registration is renewed in the background when it is close to lapsing.
  // Deliberately not awaited: a Google round trip must never be what the inbox
  // is waiting for, and the poll still covers the mailbox if it fails. A search
  // is a read of stored mail, so it does not touch the provider at all.
  if (!search) {
    void ensurePushRegistrations(userId, accounts).catch((error) => {
      console.warn('[push] renewing a watch failed:', error)
    })
  }

  let syncError: string | null = null
  let syncedNow = false
  let latestSyncedAt: Date | null = null
  const authRequiredAccounts: Array<{
    id: string
    email: string
    provider: Provider
  }> = []

  // Each mailbox is synced and freshness-checked on its own: one revoked grant
  // or one stale cursor must not stop the others from appearing. Searching skips
  // the loop entirely — there is nothing to refresh in a filtered read.
  for (const account of search ? [] : accounts) {
    await ensureDerivedFields(userId, account.id)

    const lastSyncedAt = await getLastSyncedAt(account.id)
    if (lastSyncedAt && (!latestSyncedAt || lastSyncedAt > latestSyncedAt)) {
      latestSyncedAt = lastSyncedAt
    }

    const isStale =
      opts.force === true || isCursorStale(lastSyncedAt, staleAfterMs)
    if (!isStale) continue

    // A first sync is the long one — a 30-day backfill, plus a decision (and
    // with a key configured, an LLM topic call) per thread — so it is started in
    // the background and the page is left to render. The run is deduplicated in
    // `runSync`, so the poll that follows just reads its progress.
    if (lastSyncedAt === null) {
      // Only the automatic path defers to a previous failure. `force` is the user
      // asking for a retry, so it always starts one — otherwise Re-sync could
      // never recover the mailbox the banner is complaining about.
      if (opts.force !== true) {
        const previous = lastOutcome.get(account.id)
        if (previous && (previous.error || previous.authRequired)) {
          // Report the failure and wait for that retry rather than restarting on
          // every poll: a retry that begins immediately would overwrite the
          // failure before it is ever rendered, which is the silent hang this
          // whole path exists to avoid.
          if (previous.authRequired) authRequiredAccounts.push(account)
          if (previous.error) syncError = syncError ?? previous.error
          continue
        }
      }

      // A forced run takes the same background path: the page still should not
      // block on a backfill, whoever asked for it.
      void runSync(userId, account.id, opts.full === true, account.email)
      syncedNow = true
      continue
    }

    const outcome = await runSync(
      userId,
      account.id,
      opts.full === true,
      account.email,
    )
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
      // Archived threads stay in the database and out of the normal list; a
      // search is the way back to one, so it reads them too.
      conversations: await listConversations(account.id, {
        includeArchived: Boolean(search),
      }),
    })),
  )
  const merged = mergeAccountConversations(
    perAccount.flatMap(({ accountId, conversations }) =>
      conversations.map((conversation) => ({ accountId, conversation })),
    ),
    accounts,
  )

  // A search narrows the merged list before anything is counted, so the section
  // headers describe the results rather than the whole mailbox.
  const matched = search
    ? merged.filter((row) => conversationMatchesQuery(row.conversation, search))
    : merged

  // Done threads are counted apart from the state groups, not inside them: the
  // groups are what is still open, and a handled thread sitting under "Needs
  // action" was the thing the user could not tell from work that was actually
  // waiting on them. The rule itself is a pure function (`partitionByState`), so
  // the split is testable without a database.
  const { counts, doneCount } = partitionByState(matched)
  const [organizationRules, contactImportance, stateLabels] = await Promise.all(
    [
      listOrganizationRules(userId),
      listContactImportanceByEmail(userId),
      listStateLabels(userId),
    ],
  )

  // The list is grouped by state in the UI, but ordering within a group is by
  // activity, and the union is not sorted by construction.
  matched.sort(
    (a, b) =>
      b.conversation.lastMessageAt.getTime() -
      a.conversation.lastMessageAt.getTime(),
  )

  return {
    signedIn: true,
    microsoftConfigured: isMicrosoftConfigured(),
    accounts,
    organizationRules,
    stateLabels,
    conversations: matched.map((row) =>
      toSummary(
        row,
        emailById,
        names,
        preferences.useGravatar,
        organizationRules,
        contactImportance,
      ),
    ),
    counts,
    doneCount,
    lastSyncedAt: latestSyncedAt ? latestSyncedAt.toISOString() : null,
    syncedNow,
    // Read after the sync loop, so a run started above is included with whatever
    // progress it has reached by now. In account order, which is connection order.
    syncing: accounts.flatMap((account) => {
      const entry = syncProgress.get(account.id)
      if (!entry) return []

      return [
        {
          id: account.id,
          email: account.email,
          mode: entry.mode,
          processed: entry.processed,
          estimated: entry.estimated,
        },
      ]
    }),
    syncError,
    authRequiredAccounts,
  }
}
