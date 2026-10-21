/**
 * Persistence for conversations.
 *
 * The pure model in `model.ts` has no idea this exists. Everything here maps
 * between the domain shape and the Drizzle schema, and is the only place that
 * knows both.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { withWriteLock } from '#/lib/db/write-lock.ts'
import {
  attachments,
  contacts,
  conversations,
  decisions,
  messages as messagesTable,
  accounts,
  senderProfiles,
  senderSignals,
} from '#/db/schema.ts'
import type {
  Conversation,
  ConversationAttachment,
  ConversationMessage,
  DoneMark,
  ParsingPreferences,
  StateOverride,
} from './model.ts'
import type { AccountConversation } from './merge.ts'
import type { Decision } from './decision.ts'
import { cleanMessage, conversationId, otherPartyOf } from './model.ts'
import { stripHtmlGreeting, stripHtmlSignature } from '#/lib/mail/index.ts'

import { isAutomatedThread } from './automated.ts'

/**
 * Revision of the derived conversation fields.
 *
 * Bump this whenever a new derived column is added to `conversations`. Sync only
 * rewrites threads Gmail reports as changed, so without this a new column would
 * sit at its migration default for every conversation that had already been
 * synced — and nothing would report a problem. `backfillDerivedFields` closes
 * that gap from the messages already stored locally, with no API calls.
 *
 * v2 — `messages.body_html` is now populated for every message that has an HTML
 * part, not only HTML-only mail. This cannot be backfilled locally: the old rows
 * stored no HTML at all, so recovering it needs a re-fetch from Gmail.
 *
 * v3 — greeting/signature detection was rewritten. Unlike v2 this *can* be
 * applied locally, because the text the old parser wrongly kept is still in
 * `body_text`; `reparseStoredMessages` rebuilds the pre-strip text and runs the
 * parser again. Only text that was wrongly *removed* still needs `rebackfill`.
 *
 * v4 — `conversations.replyable` was added. Derived from the stored sender
 * addresses alone, so it backfills locally like v1; the decision model's
 * contribution is only recomputed on the next sync or manual re-analyse.
 *
 * v5 — the classifier changed. Bulk and machine mail now rank `low-priority`
 * instead of claiming action, and the model may drop a rule's `needs-action`. A
 * stored `state` is only recomputed when a thread is re-decided, so unlike v4
 * this cannot be a column backfill: the version pass re-runs the pipeline over
 * the stored conversations (`redecideStoredConversations`).
 */
export const DERIVED_VERSION = 5

/**
 * Recompute derived fields for every conversation of an account.
 *
 * Reads from the local database only — no Gmail round trip — because everything
 * needed is already persisted in `messages`. Idempotent, so it is safe to run
 * again after a crash, and cheap enough to run on load when the version lags.
 */
export async function backfillDerivedFields(
  ownerEmail: string,
  unreplyableSenders: ReadonlySet<string> = new Set(),
): Promise<number> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.accountId, ownerEmail))

  await withWriteLock(async () => {
    for (const { id } of rows) {
      const msgs = await db
        .select({
          from: messagesTable.from,
          isFromOwner: messagesTable.isFromAccountOwner,
          sentAt: messagesTable.sentAt,
        })
        .from(messagesTable)
        .where(eq(messagesTable.conversationId, id))

      const isAutomated = isAutomatedThread(msgs, ownerEmail)
      // The user's own mark is read here for the same reason the decision layer
      // reads it: this pass recomputes a *derived* column, and replyability is
      // no longer purely derived. Without it a version bump would silently put
      // the composer back on every thread from a marked sender.
      const marked = unreplyableSenders.has(otherPartyOf({ messages: msgs }))
      await db
        .update(conversations)
        .set({ isAutomated, replyable: !isAutomated && !marked })
        .where(eq(conversations.id, id))
    }
  })

  return rows.length
}

/**
 * Re-apply the parser to messages already in the database.
 *
 * A parsing change normally needs `scripts/rebackfill.ts`, because only the
 * *cleaned* body is stored — the raw MIME is not. But every piece the parser saw
 * is on the row: the greeting and signature it removed (`greeting_text` /
 * `signature_text`), the quote it removed (`stripped_quote`), and the cleaned
 * body itself. Rejoining them in message order reproduces the pre-strip text, so
 * detection runs again and picks up the text a previous parser wrongly kept.
 *
 * What it cannot do is restore text a previous parser wrongly *removed*: that
 * text is gone from the row. For that direction `rebackfill` is still the only
 * fix, which is why this is a complement to it rather than a replacement.
 *
 * Messages whose sender keeps quoted history inline are skipped. Their stored
 * body still contains the quote, so rejoining the signature next to it would put
 * the signature on the wrong side of the quote and lose it.
 *
 * Idempotent: a row that is already clean reproduces itself, so it is safe to
 * run on every load where the version lags.
 */
export async function reparseStoredMessages(
  ownerEmail: string,
  context: ParsingProfileContext,
): Promise<number> {
  const conversationRows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.accountId, ownerEmail))

  const conversationIds = conversationRows.map((row) => row.id)
  if (conversationIds.length === 0) return 0

  const rows = await db
    .select({
      id: messagesTable.id,
      from: messagesTable.from,
      bodyText: messagesTable.bodyText,
      bodyHtml: messagesTable.bodyHtml,
      greetingText: messagesTable.greetingText,
      signatureText: messagesTable.signatureText,
      strippedQuote: messagesTable.strippedQuote,
    })
    .from(messagesTable)
    .where(inArray(messagesTable.conversationId, conversationIds))

  let updated = 0

  await withWriteLock(async () => {
    for (const row of rows) {
      const senderEmail = row.from.email.trim().toLowerCase()
      // A sender without a profile has no entry here at runtime, so default the
      // lookup rather than relying on the index signature.
      const senderPreferences = context.parsingPreferences[senderEmail] ?? {}
      const preferences: ParsingPreferences = {
        stripQuotedHistory:
          senderPreferences.stripQuotedHistory ??
          context.parsingDefaults.stripQuotedHistory,
        stripGreeting:
          senderPreferences.stripGreeting ??
          context.parsingDefaults.stripGreeting,
        stripSignature:
          senderPreferences.stripSignature ??
          context.parsingDefaults.stripSignature,
      }

      if (!preferences.stripQuotedHistory) continue

      const reconstructed = [
        row.greetingText,
        row.bodyText,
        row.signatureText,
        row.strippedQuote,
      ]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join('\n\n')
        .trim()

      if (!reconstructed) continue

      const cleaned = cleanMessage(
        {
          subject: '',
          from: senderEmail,
          to: [],
          cc: [],
          parts: [{ contentType: 'text/plain', text: reconstructed }],
        },
        ownerEmail,
        preferences,
      )

      // The stored HTML is already sanitised and quote-stripped, so it is only
      // trimmed further — never re-sanitised. Trimming re-serialises the document,
      // which normalises markup (`<br />` becomes `<br>`), so it is done only when
      // this pass actually detects a greeting or signature the old parser missed.
      // Otherwise the stored markup is kept byte for byte.
      const foundNewText =
        cleaned.greeting !== row.greetingText ||
        cleaned.signature !== row.signatureText
      const bodyHtml =
        row.bodyHtml && foundNewText
          ? stripHtmlSignature(
              stripHtmlGreeting(
                row.bodyHtml,
                preferences.stripGreeting ? cleaned.greeting : null,
              ),
              preferences.stripSignature ? cleaned.signature : null,
            )
          : row.bodyHtml

      await db
        .update(messagesTable)
        .set({
          bodyText: cleaned.body,
          bodyHtml,
          greetingText: cleaned.greeting,
          signatureText: cleaned.signature,
          detectedGreetingText: cleaned.detectedGreeting,
          detectedSignatureText: cleaned.detectedSignature,
          strippedQuote: cleaned.strippedQuote,
        })
        .where(eq(messagesTable.id, row.id))

      updated++
    }
  })

  return updated
}

/** Insert or replace a conversation and everything under it. */
export async function saveConversation(
  ownerEmail: string,
  conversation: Conversation,
): Promise<void> {
  const id = conversation.id
  const now = new Date()

  // SQLite allows one writer at a time; concurrent transactions would fail with
  // SQLITE_BUSY. See src/lib/db/write-lock.ts.
  await withWriteLock(async () => {
    await db.transaction(async (tx) => {
      await tx
        .insert(conversations)
        .values({
          id,
          accountId: ownerEmail,
          providerThreadId: conversation.providerThreadId,
          subject: conversation.subject,
          participants: conversation.participants,
          state: conversation.state,
          isAutomated: conversation.isAutomated,
          replyable: conversation.replyable,
          awaitingReply: conversation.awaitingReply,
          topic: conversation.topic,
          goal: conversation.goal,
          importance: conversation.importance,
          urgency: conversation.urgency,
          requiresReply: conversation.requiresReply,
          intent: conversation.intent,
          messageCount: conversation.messageCount,
          attachmentCount: conversation.attachmentCount,
          lastMessageAt: conversation.lastMessageAt,
          // The user's own call, written from the conversation rather than
          // recomputed: `decideAndSave` puts the stored call back on the object
          // before saving, and `applyDecision` clears one the thread has
          // outrun, so this column always ends up holding what the user
          // currently means.
          stateOverride: conversation.stateOverride?.state ?? null,
          stateOverrideMessageAt: conversation.stateOverride?.messageAt ?? null,
          // Written from the conversation for the same reason, and "read" is as
          // user-owned as "done": `decideAndSave` and `refreshThread` put the
          // stored pair back on the object before saving, so a rebuild from Gmail
          // cannot un-read or un-finish a thread.
          seenAt: conversation.seenAt,
          doneAt: conversation.done?.doneAt ?? null,
          doneMessageAt: conversation.done?.messageAt ?? null,
          decidedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: conversations.id,
          set: {
            subject: conversation.subject,
            participants: conversation.participants,
            state: conversation.state,
            stateOverride: conversation.stateOverride?.state ?? null,
            stateOverrideMessageAt:
              conversation.stateOverride?.messageAt ?? null,
            seenAt: conversation.seenAt,
            doneAt: conversation.done?.doneAt ?? null,
            doneMessageAt: conversation.done?.messageAt ?? null,
            isAutomated: conversation.isAutomated,
            replyable: conversation.replyable,
            awaitingReply: conversation.awaitingReply,
            importance: conversation.importance,
            urgency: conversation.urgency,
            requiresReply: conversation.requiresReply,
            intent: conversation.intent,
            messageCount: conversation.messageCount,
            attachmentCount: conversation.attachmentCount,
            lastMessageAt: conversation.lastMessageAt,
            decidedAt: now,
            updatedAt: now,
          },
        })

      // Messages are append-only from Gmail's perspective: a thread only gains
      // new messages. Replace wholesale rather than diffing — threads are small.
      await tx.delete(messagesTable).where(eq(messagesTable.conversationId, id))

      if (conversation.messages.length > 0) {
        await tx.insert(messagesTable).values(
          conversation.messages.map((m) => ({
            id: `${id}:${m.providerMessageId}`,
            conversationId: id,
            providerMessageId: m.providerMessageId,
            internetMessageId: m.internetMessageId,
            from: m.from,
            to: m.to,
            cc: m.cc,
            subject: m.subject,
            snippet: m.snippet,
            bodyText: m.body,
            bodyHtml: m.bodyHtml,
            signatureText: m.signature,
            greetingText: m.greeting,
            detectedGreetingText: m.detectedGreeting,
            detectedSignatureText: m.detectedSignature,
            strippedQuote: m.strippedQuote,
            sentAt: m.sentAt,
            isFromAccountOwner: m.isFromOwner,
          })),
        )
      }

      // Everyone this thread was addressed to or from, which is the address book
      // the new-message composer offers. An address with no display name is still
      // worth keeping — a recipient picker that only knew named senders would
      // hide half the people the user has actually corresponded with. A later
      // message that omits the name must not erase the one already learned, so
      // the conflict update coalesces instead of overwriting with null.
      const addressed = conversation.participants.filter((p) => p.email.trim())
      if (addressed.length > 0) {
        await tx
          .insert(contacts)
          .values(
            addressed.map((p) => ({
              accountId: ownerEmail,
              email: p.email.trim().toLowerCase(),
              name: p.name?.trim() || null,
              updatedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [contacts.accountId, contacts.email],
            set: {
              name: sql`coalesce(nullif(excluded.name, ''), ${contacts.name})`,
              updatedAt: sql`excluded.updated_at`,
            },
          })
      }

      if (conversation.attachments.length > 0) {
        await tx.delete(attachments).where(eq(attachments.conversationId, id))

        await tx.insert(attachments).values(
          conversation.attachments.map((a) => ({
            id: `${id}:${a.providerAttachmentId}`,
            conversationId: id,
            // Resolved to the message row id written above.
            messageId: `${id}:${a.messageId ?? a.providerMessageId}`,
            providerAttachmentId: a.providerAttachmentId,
            filename: a.filename,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            isInline: a.isInline,
            contentId: a.contentId,
          })),
        )
      }
    })
  })
}

/**
 * The greeting and signature on the user's own most recent message in a mailbox.
 *
 * The fallback for a *new* thread, where there is no conversation to read them
 * from: how the user signed their last sent mail is the best available guess at
 * how they sign this one. `detected_*` is the pair the parser always fills in,
 * whether or not the text was stripped from the stored body.
 */
export async function getLastOwnMessageStyle(accountId: string): Promise<{
  greeting: string | null
  signature: string | null
  detectedGreeting: string | null
  detectedSignature: string | null
} | null> {
  const rows = await db
    .select({
      greeting: messagesTable.greetingText,
      signature: messagesTable.signatureText,
      detectedGreeting: messagesTable.detectedGreetingText,
      detectedSignature: messagesTable.detectedSignatureText,
    })
    .from(messagesTable)
    .innerJoin(
      conversations,
      eq(conversations.id, messagesTable.conversationId),
    )
    .where(
      and(
        eq(conversations.accountId, accountId),
        eq(messagesTable.isFromAccountOwner, true),
      ),
    )
    .orderBy(desc(messagesTable.sentAt))
    .limit(1)

  const row = rows.at(0)
  if (!row) return null
  return {
    greeting: row.greeting,
    signature: row.signature,
    detectedGreeting: row.detectedGreeting,
    detectedSignature: row.detectedSignature,
  }
}

export type SenderProfileSettings = ParsingPreferences & {
  useAccountParsingDefaults: boolean
  replyStyleEnabled: boolean
  replyGreeting: string | null
  replySignature: string | null
}

export type ParsingProfileContext = {
  parsingDefaults: ParsingPreferences
  parsingPreferences: Record<string, Partial<ParsingPreferences>>
  parsingProfiles: Record<string, SenderProfileSettings>
  replyStyles: {
    account: { greeting: string | null; signature: string | null }
    senders: Record<
      string,
      { enabled: boolean; greeting: string | null; signature: string | null }
    >
  }
}

/** Load normalized parsing and reply-style profiles for an account. */
export async function getParsingProfileContext(
  accountId: string,
): Promise<ParsingProfileContext> {
  const [account, profiles] = await Promise.all([
    db.query.accounts.findFirst({ where: eq(accounts.id, accountId) }),
    db
      .select()
      .from(senderProfiles)
      .where(eq(senderProfiles.accountId, accountId)),
  ])

  const parsingDefaults: ParsingPreferences = {
    stripQuotedHistory: account?.defaultStripQuotedHistory ?? true,
    stripGreeting: account?.defaultStripGreeting ?? true,
    stripSignature: account?.defaultStripSignature ?? true,
  }
  const parsingPreferences: ParsingProfileContext['parsingPreferences'] = {}
  const parsingProfiles: ParsingProfileContext['parsingProfiles'] = {}
  const senders: ParsingProfileContext['replyStyles']['senders'] = {}
  for (const profile of profiles) {
    const email = profile.senderEmail.trim().toLowerCase()
    const senderSettings: SenderProfileSettings = {
      useAccountParsingDefaults: profile.useAccountParsingDefaults,
      stripQuotedHistory: profile.stripQuotedHistory,
      stripGreeting: profile.stripGreeting,
      stripSignature: profile.stripSignature,
      replyStyleEnabled: profile.replyStyleEnabled,
      replyGreeting: profile.replyGreeting,
      replySignature: profile.replySignature,
    }
    parsingProfiles[email] = senderSettings
    parsingPreferences[email] = profile.useAccountParsingDefaults
      ? parsingDefaults
      : {
          stripQuotedHistory: profile.stripQuotedHistory,
          stripGreeting: profile.stripGreeting,
          stripSignature: profile.stripSignature,
        }
    senders[email] = {
      enabled: profile.replyStyleEnabled,
      greeting: profile.replyGreeting,
      signature: profile.replySignature,
    }
  }

  return {
    parsingDefaults,
    parsingPreferences,
    parsingProfiles,
    replyStyles: {
      account: {
        greeting: account?.defaultReplyGreeting ?? null,
        signature: account?.defaultReplySignature ?? null,
      },
      senders,
    },
  }
}

/** Persist account defaults and a single sender-specific learned profile. */
export async function saveParsingProfile(
  accountId: string,
  senderEmail: string,
  defaults: {
    greeting: string | null
    signature: string | null
    parsing: ParsingPreferences
  },
  profile: SenderProfileSettings,
): Promise<void> {
  const email = senderEmail.trim().toLowerCase()
  const id = `${accountId}:${email}`
  if (!email || email === accountId.trim().toLowerCase()) {
    throw new Error('Cannot save a sender profile for the account owner.')
  }
  await withWriteLock(async () => {
    await db.transaction(async (tx) => {
      await tx
        .update(accounts)
        .set({
          defaultReplyGreeting: defaults.greeting,
          defaultReplySignature: defaults.signature,
          defaultStripQuotedHistory: defaults.parsing.stripQuotedHistory,
          defaultStripGreeting: defaults.parsing.stripGreeting,
          defaultStripSignature: defaults.parsing.stripSignature,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId))

      await tx
        .insert(senderProfiles)
        .values({
          id,
          accountId,
          senderEmail: email,
          stripQuotedHistory: profile.stripQuotedHistory,
          stripGreeting: profile.stripGreeting,
          stripSignature: profile.stripSignature,
          useAccountParsingDefaults: profile.useAccountParsingDefaults,
          replyStyleEnabled: profile.replyStyleEnabled,
          replyGreeting: profile.replyGreeting,
          replySignature: profile.replySignature,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: senderProfiles.id,
          set: {
            stripQuotedHistory: profile.stripQuotedHistory,
            stripGreeting: profile.stripGreeting,
            stripSignature: profile.stripSignature,
            useAccountParsingDefaults: profile.useAccountParsingDefaults,
            replyStyleEnabled: profile.replyStyleEnabled,
            replyGreeting: profile.replyGreeting,
            replySignature: profile.replySignature,
            updatedAt: new Date(),
          },
        })
    })
  })
}

/**
 * Mark one sender as replyable or not — the user's own answer, per sender.
 *
 * Insert-or-update rather than a plain update, because a sender the user has
 * never tuned has no row at all. The insert therefore has to say "inherit the
 * account's parsing defaults" instead of leaving the schema's own defaults to
 * apply: those are `true` for each strip flag, so writing them would quietly
 * start stripping quoted history for a sender whose mail the account is set up to
 * keep intact. Marking a sender changes exactly one thing.
 *
 * Only `replyable` is written on conflict, so a sender who already has parsing or
 * reply-style settings keeps every one of them.
 */
export async function setSenderReplyable(
  accountId: string,
  senderEmail: string,
  replyable: boolean,
): Promise<void> {
  const email = senderEmail.trim().toLowerCase()
  // Silent rather than throwing, like `recordSenderSignal`: neither the account
  // owner's own address nor a thread with no other party can be a sender to
  // mark, and an action that arrived with one has nothing to apply.
  if (!email || email === accountId.trim().toLowerCase()) return

  const id = `${accountId}:${email}`

  await withWriteLock(async () => {
    await db
      .insert(senderProfiles)
      .values({
        id,
        accountId,
        senderEmail: email,
        useAccountParsingDefaults: true,
        replyable,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: senderProfiles.id,
        set: { replyable, updatedAt: new Date() },
      })
  })
}

/**
 * Senders the user has marked as ones a reply cannot reach.
 *
 * A plain set of addresses, read once per sync and passed down the batch, for the
 * same reason `listIgnoredSenders` is: the decision path runs per thread and must
 * not ask the same question once per row.
 */
export async function listUnreplyableSenders(
  accountId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ senderEmail: senderProfiles.senderEmail })
    .from(senderProfiles)
    .where(
      and(
        eq(senderProfiles.accountId, accountId),
        eq(senderProfiles.replyable, false),
      ),
    )

  return new Set(rows.map((row) => row.senderEmail.trim().toLowerCase()))
}

/** One sender the user has actually received mail from. */
export type IncomingSender = {
  /** Normalised, which is the form the can't-reply list stores. */
  email: string
  /** Display name, when any message from them carried one. */
  name: string | null
  /** Newest message from them — the ordering key, and a "when" hint. */
  lastMessageAt: Date
}

/**
 * Senders the user has actually received from, newest first.
 *
 * The quick half of the can't-reply list: addresses that can be recognised and
 * clicked rather than recalled and typed. Read from the stored messages, because
 * a thread's counterpart is `otherPartyOf`'s answer per *thread* and what this
 * wants is every address that has written at all.
 *
 * Only threads that still show a reply box are considered, and that single filter
 * does three jobs: a sender already marked is excluded (the sweep sets all of
 * their threads to `replyable = false`), a machine sender is excluded (their
 * threads are already unanswerable without anyone being asked), and the list can
 * never offer an address that marking would do nothing for. The user's own
 * addresses are filtered separately, because a thread between two of their
 * mailboxes has a non-owner side that is still theirs.
 *
 * `ownerEmails` is normalised here rather than trusted, so a caller does not have
 * to remember that the comparison is on lowercased addresses.
 */
export async function listIncomingSenders(
  accountId: string,
  ownerEmails: ReadonlySet<string>,
  limit = 8,
): Promise<IncomingSender[]> {
  const rows = await db
    .select({ from: messagesTable.from, sentAt: messagesTable.sentAt })
    .from(messagesTable)
    .innerJoin(
      conversations,
      eq(conversations.id, messagesTable.conversationId),
    )
    .where(
      and(
        eq(conversations.accountId, accountId),
        eq(messagesTable.isFromAccountOwner, false),
        eq(conversations.replyable, true),
      ),
    )

  const owners = new Set(
    [...ownerEmails].map((email) => email.trim().toLowerCase()),
  )

  // Grouped here rather than in SQL: `from` is a JSON participant, and the name
  // has to survive a newer message that omits it.
  const byEmail = new Map<string, IncomingSender>()
  for (const row of rows) {
    const email = row.from.email.trim().toLowerCase()
    if (!email || owners.has(email)) continue

    const name = row.from.name?.trim() || null
    const existing = byEmail.get(email)
    if (!existing) {
      byEmail.set(email, { email, name, lastMessageAt: row.sentAt })
      continue
    }

    if (row.sentAt > existing.lastMessageAt) existing.lastMessageAt = row.sentAt
    // First non-empty name wins, so a bare address on the newest message does not
    // erase what an earlier one knew.
    if (!existing.name && name) existing.name = name
  }

  return [...byEmail.values()]
    .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
    .slice(0, limit)
}

/**
 * Apply a sender's replyability to every thread already stored from them.
 *
 * The decision layer covers new and re-decided mail, which leaves the threads the
 * user is looking at right now untouched — so this sweep runs on the click. It
 * reads the account's messages rather than loading whole conversations
 * (`listConversations` re-parses every body) because it sits behind a button.
 *
 * A thread's sender is `otherPartyOf`'s, so the sweep agrees with the decision
 * path about which address a thread belongs to. Machine mail keeps its own veto:
 * taking a mark back can never hand a composer to a `noreply@` address.
 *
 * Returns how many rows actually changed, so a caller can tell "nothing to do"
 * from "done" — and so a test can assert on the effect.
 */
export async function setReplyableForSender(
  accountId: string,
  senderEmail: string,
  replyable: boolean,
): Promise<number> {
  const email = senderEmail.trim().toLowerCase()
  if (!email) return 0

  const rows = await db
    .select({
      conversationId: messagesTable.conversationId,
      currentReplyable: conversations.replyable,
      from: messagesTable.from,
      isFromOwner: messagesTable.isFromAccountOwner,
      sentAt: messagesTable.sentAt,
    })
    .from(messagesTable)
    .innerJoin(
      conversations,
      eq(conversations.id, messagesTable.conversationId),
    )
    .where(eq(conversations.accountId, accountId))

  const byConversation = new Map<string, typeof rows>()
  for (const row of rows) {
    const list = byConversation.get(row.conversationId)
    if (list) list.push(row)
    else byConversation.set(row.conversationId, [row])
  }

  const target = new Map<string, boolean>()
  // `rowId` rather than `conversationId`: that name is the id builder imported
  // above, and shadowing it here is how a row id gets mistaken for a derived key.
  for (const [rowId, messages] of byConversation) {
    // Ordered here rather than in SQL: `otherPartyOf` reads the *newest* message
    // not written by the user, and the join comes back in whatever order the
    // table happens to hold.
    const ordered = [...messages].sort(
      (a, b) => a.sentAt.getTime() - b.sentAt.getTime(),
    )
    if (otherPartyOf({ messages: ordered }) !== email) continue

    const next = replyable && !isAutomatedThread(ordered, accountId)
    // The column is per conversation, so any row of the group carries it.
    if (next === messages[0]?.currentReplyable) continue
    target.set(rowId, next)
  }

  if (target.size === 0) return 0

  await withWriteLock(async () => {
    // Two statements, one per value, because the account's threads can hold both
    // and a single `IN` list would have to be split anyway.
    for (const value of [false, true]) {
      const ids = [...target]
        .filter(([, next]) => next === value)
        .map(([id]) => id)
      if (ids.length === 0) continue

      await db
        .update(conversations)
        .set({ replyable: value, updatedAt: new Date() })
        .where(
          and(
            eq(conversations.accountId, accountId),
            inArray(conversations.id, ids),
          ),
        )
    }
  })

  return target.size
}

/** Record a decision for audit, alongside the conversation's current values. */
export async function recordDecision(
  conversation: Conversation,
  decision: Decision,
): Promise<void> {
  await withWriteLock(async () => {
    await db.insert(decisions).values({
      id: `${conversation.id}:${Date.now()}`,
      conversationId: conversation.id,
      // The stages that produced this row, in order (e.g. `rules+jev+llm`).
      provider: decision.providers.join('+'),
      state: decision.state,
      importance: decision.importance,
      urgency: decision.urgency,
      requiresReply: decision.requiresReply,
      // `intent` is user-owned: the decision layer does not produce it, so the
      // audit row records whatever the conversation currently carries.
      intent: conversation.intent,
      topic: decision.topic,
      reasoning: decision.reasoning,
      decidedAt: new Date(),
    })
  })
}

/** List conversations for an account, newest activity first. */
export async function listConversations(
  accountId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<Conversation[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.accountId, accountId))
    .orderBy(desc(conversations.lastMessageAt))

  const filtered = opts.includeArchived
    ? rows
    : rows.filter((r) => !r.isArchived)

  return Promise.all(filtered.map(rowToConversation))
}

/**
 * Gmail thread ids already stored for an account.
 *
 * Exists for the maintenance script that re-fetches threads after a parsing
 * change. Ids come from here rather than from a `newer_than:` search because a
 * date window only covers mail still inside it — threads the app already shows
 * drop out of the window purely by ageing.
 *
 * `onlyMissingHtml` narrows to threads that still have a message with no stored
 * HTML, which is what a rendering fix needs re-fetched.
 */
export async function getStoredThreadIds(
  ownerEmail: string,
  opts: { onlyMissingHtml?: boolean } = {},
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ providerThreadId: conversations.providerThreadId })
    .from(conversations)
    .where(eq(conversations.accountId, ownerEmail))

  if (!opts.onlyMissingHtml) return rows.map((r) => r.providerThreadId)

  // `notExists` rather than a left join + null check: the subquery keeps this to
  // one round trip and states the intent directly.
  const lackingHtml = await db
    .selectDistinct({ conversationId: messagesTable.conversationId })
    .from(messagesTable)
    .where(
      and(
        isNull(messagesTable.bodyHtml),
        inArray(
          messagesTable.conversationId,
          rows.map((r) => conversationId(ownerEmail, r.providerThreadId)),
        ),
      ),
    )

  const missing = new Set(lackingHtml.map((r) => r.conversationId))

  return rows
    .map((r) => r.providerThreadId)
    .filter((threadId) => missing.has(conversationId(ownerEmail, threadId)))
}

/**
 * Find a conversation by thread id in *any* connected account.
 *
 * Thread ids are mailbox-scoped and the inbox can span several accounts, so the
 * conversation view cannot be scoped to one session account any more — the row
 * the user clicked belongs to whichever mailbox owns it. The account id comes
 * back alongside the conversation because the reply and the sender profile both
 * need to know whose mailbox they are working in.
 */
/**
 * The mailboxes this user owns.
 *
 * Empty for a signed-out or unknown user, which makes every query below return
 * nothing rather than everything — the failure direction that matters.
 */
async function ownedAccountIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, userId.toLowerCase()))

  return rows.map((row) => row.id)
}

export async function getConversationByThreadId(
  userId: string,
  providerThreadId: string,
): Promise<{ accountId: string; conversation: Conversation } | null> {
  const owned = await ownedAccountIds(userId)
  if (owned.length === 0) return null

  const row = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.providerThreadId, providerThreadId),
      inArray(conversations.accountId, owned),
    ),
  })
  if (!row) return null

  return {
    accountId: row.accountId,
    conversation: await rowToConversation(row),
  }
}

/**
 * Every stored conversation connected to a thread by a shared `Message-ID`,
 * across all accounts — the cluster the inbox merges into one row.
 *
 * A thread id resolves to *one* mailbox's copy, and that copy is not always the
 * whole conversation. Gmail does not guarantee it threads a message the same way
 * in the sender's and recipient's mailboxes: a message sent between two of the
 * user's own accounts can live in a nine-message thread in one mailbox and as
 * several single-message threads in the other. Rendering only the thread id's
 * conversation therefore showed a fragment and hid the rest — so the detail view
 * has to resolve the same Message-ID-connected component the inbox merges.
 *
 * Walked transitively (BFS over message ids) rather than one hop, because the
 * fragments only link to each other through the shared ids they carry.
 */
export async function getConversationClusterByThreadId(
  userId: string,
  providerThreadId: string,
): Promise<AccountConversation[] | null> {
  // Scoped to the reader's mailboxes, and the scope is applied to every hop of
  // the walk — not only to the seed. Thread ids and `Message-ID`s are global
  // values: two people on one install can perfectly well both have received the
  // same message, and walking a shared id without the owner filter would fold a
  // stranger's copy of it into this user's conversation.
  const owned = await ownedAccountIds(userId)
  if (owned.length === 0) return null

  const seed = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.providerThreadId, providerThreadId),
      inArray(conversations.accountId, owned),
    ),
  })
  if (!seed) return null

  const visited = new Set<string>([seed.id])
  let frontier = [seed.id]

  while (frontier.length > 0) {
    const ids = frontier
    frontier = []

    const messageRows = await db
      .selectDistinct({ internetMessageId: messagesTable.internetMessageId })
      .from(messagesTable)
      .where(inArray(messagesTable.conversationId, ids))
    const messageIds = messageRows
      .map((row) => row.internetMessageId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)

    if (messageIds.length === 0) continue

    const neighbours = await db
      .selectDistinct({ conversationId: messagesTable.conversationId })
      .from(messagesTable)
      .innerJoin(
        conversations,
        eq(conversations.id, messagesTable.conversationId),
      )
      .where(
        and(
          inArray(messagesTable.internetMessageId, messageIds),
          inArray(conversations.accountId, owned),
        ),
      )

    for (const { conversationId: neighbourId } of neighbours) {
      if (visited.has(neighbourId)) continue
      visited.add(neighbourId)
      frontier.push(neighbourId)
    }
  }

  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        inArray(conversations.id, [...visited]),
        inArray(conversations.accountId, owned),
      ),
    )

  return Promise.all(
    rows.map(async (row) => ({
      accountId: row.accountId,
      conversation: await rowToConversation(row),
    })),
  )
}

/** Fetch one conversation with its messages and attachments. */
export async function getConversation(
  accountId: string,
  providerThreadId: string,
): Promise<Conversation | null> {
  const id = conversationId(accountId, providerThreadId)

  const row = await db.query.conversations.findFirst({
    where: eq(conversations.id, id),
  })

  if (!row) return null

  return rowToConversation(row)
}

/**
 * Set the user's goal.
 *
 * This is the one field the user owns outright — no decision layer writes it.
 */
export async function setGoal(
  accountId: string,
  providerThreadId: string,
  goal: string | null,
): Promise<void> {
  await setConversationDetails(accountId, providerThreadId, { goal })
}

/** Persist both user-owned conversation details under the SQLite write lock. */
export async function setConversationDetails(
  accountId: string,
  providerThreadId: string,
  details: { topic?: string | null; goal?: string | null },
): Promise<void> {
  const id = conversationId(accountId, providerThreadId)

  await withWriteLock(async () => {
    await db
      .update(conversations)
      .set({ ...details, updatedAt: new Date() })
      .where(
        and(eq(conversations.id, id), eq(conversations.accountId, accountId)),
      )
  })
}

/** Persist a user-edited topic. */
export async function setTopic(
  accountId: string,
  providerThreadId: string,
  topic: string | null,
): Promise<void> {
  await setConversationDetails(accountId, providerThreadId, { topic })
}

/** Map a DB row back into the domain shape. */
async function rowToConversation(
  row: typeof conversations.$inferSelect,
): Promise<Conversation> {
  const [msgs, atts] = await Promise.all([
    db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, row.id))
      .orderBy(messagesTable.sentAt),
    db.select().from(attachments).where(eq(attachments.conversationId, row.id)),
  ])

  const messages: ConversationMessage[] = msgs.map((m) => ({
    providerMessageId: m.providerMessageId,
    internetMessageId: m.internetMessageId,
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    snippet: m.snippet,
    body: m.bodyText ?? '',
    bodyHtml: m.bodyHtml,
    greeting: m.greetingText,
    signature: m.signatureText,
    isFromOwner: m.isFromAccountOwner,
    sentAt: m.sentAt,
    detectedGreeting: m.detectedGreetingText ?? m.greetingText,
    detectedSignature: m.detectedSignatureText ?? m.signatureText,
    strippedGreeting: m.greetingText,
    strippedSignature: m.signatureText,
    strippedQuote: m.strippedQuote,
    replyGreeting: null,
    replySignature: null,
    parsingPreferences: {
      stripQuotedHistory: true,
      stripGreeting: true,
      stripSignature: true,
    },
  }))

  // A stored attachment points at a message by that message's *row* id. The
  // domain field is the message's own identity, which `saveConversation`
  // re-prefixes, so the row prefix is stripped here. Leaving it on broke two
  // things at once: the chat view matches attachments to messages by this value
  // (so no chip rendered), and re-saving — which is what re-analysis does —
  // wrote `<conversation>:<conversation>:<identity>`, a foreign key pointing at
  // no row, and the save failed outright.
  const messageRowPrefix = `${row.id}:`
  const conversationAttachments: ConversationAttachment[] = atts.map((a) => {
    const identity = a.messageId.startsWith(messageRowPrefix)
      ? a.messageId.slice(messageRowPrefix.length)
      : a.messageId

    return {
      providerMessageId: identity,
      messageId: identity,
      providerAttachmentId: a.providerAttachmentId,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      isInline: a.isInline,
      contentId: a.contentId,
    }
  })

  return {
    id: row.id,
    providerThreadId: row.providerThreadId,
    subject: row.subject,
    participants: row.participants,
    messages,
    attachments: conversationAttachments,
    state: row.state,
    isAutomated: row.isAutomated,
    replyable: row.replyable,
    awaitingReply: row.awaitingReply,
    requiresReply: row.requiresReply,
    importance: row.importance,
    urgency: row.urgency,
    intent: row.intent,
    messageCount: row.messageCount,
    attachmentCount: row.attachmentCount,
    lastMessageAt: row.lastMessageAt,
    topic: row.topic,
    goal: row.goal,
    // The pair is written together, so a missing timestamp would mean a row
    // from before this column existed. `lastMessageAt` is the honest stand-in
    // for "when they said it" there, and it keeps the call live rather than
    // silently discarding it.
    stateOverride: row.stateOverride
      ? {
          state: row.stateOverride,
          messageAt: row.stateOverrideMessageAt ?? row.lastMessageAt,
        }
      : null,
    seenAt: row.seenAt,
    // Not clamped to `lastMessageAt` here: a mark older than the newest message is
    // a thread that came back, and the reader has to see it as not done. The
    // clamping is `activeDone`'s job, so a caller that wants the raw stored mark
    // can still have it.
    done: row.doneAt
      ? {
          doneAt: row.doneAt,
          messageAt: row.doneMessageAt ?? row.lastMessageAt,
        }
      : null,
  }
}

/**
 * Store the user's own call on a conversation, or clear it.
 *
 * `state` is written alongside the override because the call is the state: every
 * reader of the list groups by that column, and a stored call the column
 * contradicts would show the thread exactly where the user just said it was not.
 * Clearing the call deliberately leaves the state alone — the caller re-decides,
 * which is the only thing that can say where the thread belongs now.
 */
export async function setStateOverride(
  accountId: string,
  providerThreadId: string,
  override: StateOverride | null,
): Promise<void> {
  const id = conversationId(accountId, providerThreadId)

  await withWriteLock(async () => {
    await db
      .update(conversations)
      .set({
        stateOverride: override?.state ?? null,
        stateOverrideMessageAt: override?.messageAt ?? null,
        ...(override ? { state: override.state } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(conversations.id, id), eq(conversations.accountId, accountId)),
      )
  })
}

/**
 * Everything about a conversation that belongs to the user rather than to Gmail.
 *
 * One read for all three, because all three exist for the same reason and are
 * needed by the same two callers: a thread rebuilt from Gmail carries no memory
 * of what the user said or read, so the row is the only place those answers live,
 * and every rebuild has to put them back before saving. A single query also means
 * a rebuild cannot pick up one of them and drop another.
 */
export type StoredUserFields = {
  stateOverride: StateOverride | null
  seenAt: Date | null
  done: DoneMark | null
}

/**
 * The user-owned fields of one conversation, exactly as stored.
 *
 * `stateOverride` and `done` come back even when the thread has outrun them — the
 * clamping belongs to `activeStateOverride` and `activeDone`, and doing it here
 * would silently discard a mark that a later sync might yet agree with.
 */
export async function getStoredUserFields(
  accountId: string,
  providerThreadId: string,
): Promise<StoredUserFields> {
  const rows = await db
    .select({
      stateOverride: conversations.stateOverride,
      stateOverrideMessageAt: conversations.stateOverrideMessageAt,
      seenAt: conversations.seenAt,
      doneAt: conversations.doneAt,
      doneMessageAt: conversations.doneMessageAt,
      lastMessageAt: conversations.lastMessageAt,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId(accountId, providerThreadId)))
    .limit(1)

  const found = rows.at(0)
  if (!found) return { stateOverride: null, seenAt: null, done: null }

  return {
    stateOverride: found.stateOverride
      ? {
          state: found.stateOverride,
          messageAt: found.stateOverrideMessageAt ?? found.lastMessageAt,
        }
      : null,
    seenAt: found.seenAt,
    done: found.doneAt
      ? {
          doneAt: found.doneAt,
          messageAt: found.doneMessageAt ?? found.lastMessageAt,
        }
      : null,
  }
}

/**
 * The stored call on one conversation, live or not. A view of the read above.
 *
 * A caller that also has to preserve reading and the Done mark should use
 * `getStoredUserFields` instead of this, so a rebuild never carries one of the
 * user's answers and drops another.
 */
export async function getStateOverride(
  accountId: string,
  providerThreadId: string,
): Promise<StateOverride | null> {
  return (await getStoredUserFields(accountId, providerThreadId)).stateOverride
}

/**
 * Record that the user has seen this thread, up to a given message.
 *
 * Called when the conversation opens. The high-water mark only ever moves
 * forward, so opening an old thread cannot un-read newer mail, and the value the
 * *client* saw is what is written rather than the row's newest message: mail that
 * synced in between is not mail they have read, and marking it seen would lose
 * it.
 *
 * Nothing else changes. In particular the state and the Done mark are untouched —
 * reading a thread is not dealing with it, which is the whole reason "done" is
 * stored separately.
 */
export async function markConversationSeen(
  accountId: string,
  providerThreadId: string,
  seenThrough: Date,
): Promise<void> {
  const id = conversationId(accountId, providerThreadId)

  await withWriteLock(async () => {
    const rows = await db
      .select({ seenAt: conversations.seenAt })
      .from(conversations)
      .where(
        and(eq(conversations.id, id), eq(conversations.accountId, accountId)),
      )
      .limit(1)

    const current = rows.at(0)?.seenAt ?? null
    if (current && current.getTime() >= seenThrough.getTime()) return

    await db
      .update(conversations)
      .set({ seenAt: seenThrough, updatedAt: new Date() })
      .where(
        and(eq(conversations.id, id), eq(conversations.accountId, accountId)),
      )
  })
}

/**
 * Mark a conversation done, or take the mark back.
 *
 * The thread's own `lastMessageAt` is what is stored alongside the mark, not
 * anything from the caller: the mark means "the mail as it stands now is handled",
 * and a time supplied by the browser could be older than a message and make the
 * mark look current when it is not.
 *
 * As with the state override, taking the mark back does not re-decide anything.
 * The state was never changed by the mark, so there is nothing to restore.
 */
export async function setConversationDone(
  accountId: string,
  providerThreadId: string,
  done: boolean,
): Promise<void> {
  const id = conversationId(accountId, providerThreadId)

  await withWriteLock(async () => {
    const rows = await db
      .select({ lastMessageAt: conversations.lastMessageAt })
      .from(conversations)
      .where(
        and(eq(conversations.id, id), eq(conversations.accountId, accountId)),
      )
      .limit(1)

    const found = rows.at(0)
    if (!found) return

    const now = new Date()
    await db
      .update(conversations)
      .set({
        doneAt: done ? now : null,
        doneMessageAt: done ? found.lastMessageAt : null,
        updatedAt: now,
      })
      .where(
        and(eq(conversations.id, id), eq(conversations.accountId, accountId)),
      )
  })
}

/** What the user most recently did with mail from one sender. */
export type SenderSignal = 'ignored' | 'restored'

/**
 * Remember that the user filed a sender away, or brought one back.
 *
 * Deliberately only the timestamp: the *latest* signal is the one that counts
 * (see `listIgnoredSenders`), so there is no history to keep and no counter to
 * get out of step with what the user actually did.
 */
export async function recordSenderSignal(
  accountId: string,
  senderEmail: string,
  signal: SenderSignal,
): Promise<void> {
  const email = senderEmail.trim().toLowerCase()
  if (!email || email === accountId.trim().toLowerCase()) return

  const now = new Date()
  const id = `${accountId}:${email}`

  await withWriteLock(async () => {
    await db
      .insert(senderSignals)
      .values({
        id,
        accountId,
        senderEmail: email,
        ignoredAt: signal === 'ignored' ? now : null,
        restoredAt: signal === 'restored' ? now : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: senderSignals.id,
        set:
          signal === 'ignored'
            ? { ignoredAt: now, updatedAt: now }
            : { restoredAt: now, updatedAt: now },
      })
  })
}

/**
 * Senders whose mail the user has filed away, and not brought back.
 *
 * A restore only counts until the next ignore: the user telling the app "this
 * one matters" is about the sender as a whole, so it switches the learning off
 * rather than being weighed against it. Reading it this way is what keeps the
 * button honest — the alternative, a net count, makes bringing a thread back do
 * nothing for a sender with several ignores behind it.
 */
export async function listIgnoredSenders(
  accountId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({
      senderEmail: senderSignals.senderEmail,
      ignoredAt: senderSignals.ignoredAt,
      restoredAt: senderSignals.restoredAt,
    })
    .from(senderSignals)
    .where(eq(senderSignals.accountId, accountId))

  const ignored = new Set<string>()
  for (const row of rows) {
    if (!row.ignoredAt) continue
    if (row.restoredAt && row.restoredAt >= row.ignoredAt) continue
    ignored.add(row.senderEmail.trim().toLowerCase())
  }

  return ignored
}

/** Delete a conversation and its children. */
export async function deleteConversation(
  accountId: string,
  providerThreadId: string,
): Promise<void> {
  const id = conversationId(accountId, providerThreadId)
  await db.delete(conversations).where(eq(conversations.id, id))
}

/** Count conversations by state, for the inbox sidebar. */
export async function countByState(
  accountId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ state: conversations.state, count: conversations.id })
    .from(conversations)
    .where(eq(conversations.accountId, accountId))

  const counts: Record<string, number> = {}
  for (const r of rows) {
    counts[r.state] = (counts[r.state] ?? 0) + 1
  }
  return counts
}

/** Fetch many conversations by Gmail thread id. */
export async function getByThreadIds(
  accountId: string,
  threadIds: string[],
): Promise<Conversation[]> {
  if (threadIds.length === 0) return []

  const ids = threadIds.map((t) => conversationId(accountId, t))
  const rows = await db
    .select()
    .from(conversations)
    .where(inArray(conversations.id, ids))

  return Promise.all(rows.map(rowToConversation))
}

/**
 * One attachment row, with everything needed to fetch its bytes.
 *
 * `accountId` is the mailbox to ask Gmail for it, and `id` is the row's own key
 * so the download can record where the file landed.
 */
export type StoredAttachment = {
  id: string
  accountId: string
  providerThreadId: string
  providerAttachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
  isInline: boolean
  contentId: string | null
  localPath: string | null
}

/**
 * Find one stored attachment by the two ids the chat view holds.
 *
 * The thread id is mailbox-scoped, so the account comes back with it — the
 * download needs it to build a Gmail client. Resolved through the conversation
 * rather than from a stored account column because an attachment's row does not
 * repeat its account, and the conversation already knows it.
 */
export async function getStoredAttachment(
  userId: string,
  providerThreadId: string,
  providerAttachmentId: string,
): Promise<StoredAttachment | null> {
  const owned = await ownedAccountIds(userId)
  if (owned.length === 0) return null

  const rows = await db
    .select({ attachment: attachments, accountId: conversations.accountId })
    .from(attachments)
    .innerJoin(conversations, eq(conversations.id, attachments.conversationId))
    .where(
      and(
        eq(conversations.providerThreadId, providerThreadId),
        eq(attachments.providerAttachmentId, providerAttachmentId),
        inArray(conversations.accountId, owned),
      ),
    )
    .limit(1)

  // `.at(0)` rather than `[0]`: the index form is typed as always-present, which
  // hides the real "no such attachment" case.
  const found = rows.at(0)
  if (!found) return null

  const row = found.attachment
  return {
    id: row.id,
    accountId: found.accountId,
    providerThreadId,
    providerAttachmentId: row.providerAttachmentId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    isInline: row.isInline,
    contentId: row.contentId,
    localPath: row.localPath,
  }
}

/**
 * Record the on-disk path for a downloaded attachment.
 *
 * Kept separate from `saveConversation` because attachments are fetched lazily —
 * a conversation is persisted long before anyone needs its files.
 */
export async function setAttachmentLocalPath(
  attachmentRowId: string,
  localPath: string,
): Promise<void> {
  await withWriteLock(async () => {
    await db
      .update(attachments)
      .set({ localPath })
      .where(eq(attachments.id, attachmentRowId))
  })
}

/** Conversations in a given state, newest first. Used for the grouped inbox. */
export async function listByState(
  accountId: string,
  state: Conversation['state'],
): Promise<Conversation[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.accountId, accountId),
        eq(conversations.state, state),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))

  return Promise.all(rows.map(rowToConversation))
}
