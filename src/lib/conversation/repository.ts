/**
 * Persistence for conversations.
 *
 * The pure model in `model.ts` has no idea this exists. Everything here maps
 * between the domain shape and the Drizzle schema, and is the only place that
 * knows both.
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { withWriteLock } from '#/lib/db/write-lock.ts'
import {
  attachments,
  conversations,
  decisions,
  messages as messagesTable,
  accounts,
  senderProfiles,
} from '#/db/schema.ts'
import type {
  Conversation,
  ConversationAttachment,
  ConversationMessage,
  ParsingPreferences,
} from './model.ts'
import type { AccountConversation } from './merge.ts'
import type { Decision } from './decision.ts'
import { cleanMessage, conversationId } from './model.ts'
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
 */
export const DERIVED_VERSION = 4

/**
 * Recompute derived fields for every conversation of an account.
 *
 * Reads from the local database only — no Gmail round trip — because everything
 * needed is already persisted in `messages`. Idempotent, so it is safe to run
 * again after a crash, and cheap enough to run on load when the version lags.
 */
export async function backfillDerivedFields(
  ownerEmail: string,
): Promise<number> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.accountId, ownerEmail))

  await withWriteLock(async () => {
    for (const { id } of rows) {
      const msgs = await db
        .select({ from: messagesTable.from })
        .from(messagesTable)
        .where(eq(messagesTable.conversationId, id))

      const isAutomated = isAutomatedThread(msgs, ownerEmail)
      await db
        .update(conversations)
        .set({ isAutomated, replyable: !isAutomated })
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
          gmailThreadId: conversation.gmailThreadId,
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
            id: `${id}:${m.gmailMessageId}`,
            conversationId: id,
            gmailMessageId: m.gmailMessageId,
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

      if (conversation.attachments.length > 0) {
        await tx.delete(attachments).where(eq(attachments.conversationId, id))

        await tx.insert(attachments).values(
          conversation.attachments.map((a) => ({
            id: `${id}:${a.gmailAttachmentId}`,
            conversationId: id,
            // Resolved to the message row id written above.
            messageId: `${id}:${a.messageId ?? a.gmailMessageId}`,
            gmailAttachmentId: a.gmailAttachmentId,
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
    .selectDistinct({ gmailThreadId: conversations.gmailThreadId })
    .from(conversations)
    .where(eq(conversations.accountId, ownerEmail))

  if (!opts.onlyMissingHtml) return rows.map((r) => r.gmailThreadId)

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
          rows.map((r) => conversationId(ownerEmail, r.gmailThreadId)),
        ),
      ),
    )

  const missing = new Set(lackingHtml.map((r) => r.conversationId))

  return rows
    .map((r) => r.gmailThreadId)
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
export async function getConversationByThreadId(
  gmailThreadId: string,
): Promise<{ accountId: string; conversation: Conversation } | null> {
  const row = await db.query.conversations.findFirst({
    where: eq(conversations.gmailThreadId, gmailThreadId),
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
  gmailThreadId: string,
): Promise<AccountConversation[] | null> {
  const seed = await db.query.conversations.findFirst({
    where: eq(conversations.gmailThreadId, gmailThreadId),
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
      .where(inArray(messagesTable.internetMessageId, messageIds))

    for (const { conversationId: neighbourId } of neighbours) {
      if (visited.has(neighbourId)) continue
      visited.add(neighbourId)
      frontier.push(neighbourId)
    }
  }

  const rows = await db
    .select()
    .from(conversations)
    .where(inArray(conversations.id, [...visited]))

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
  gmailThreadId: string,
): Promise<Conversation | null> {
  const id = conversationId(accountId, gmailThreadId)

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
  gmailThreadId: string,
  goal: string | null,
): Promise<void> {
  await setConversationDetails(accountId, gmailThreadId, { goal })
}

/** Persist both user-owned conversation details under the SQLite write lock. */
export async function setConversationDetails(
  accountId: string,
  gmailThreadId: string,
  details: { topic?: string | null; goal?: string | null },
): Promise<void> {
  const id = conversationId(accountId, gmailThreadId)

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
  gmailThreadId: string,
  topic: string | null,
): Promise<void> {
  await setConversationDetails(accountId, gmailThreadId, { topic })
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
    gmailMessageId: m.gmailMessageId,
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
      gmailMessageId: identity,
      messageId: identity,
      gmailAttachmentId: a.gmailAttachmentId,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      isInline: a.isInline,
      contentId: a.contentId,
    }
  })

  return {
    id: row.id,
    gmailThreadId: row.gmailThreadId,
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
  }
}

/** Delete a conversation and its children. */
export async function deleteConversation(
  accountId: string,
  gmailThreadId: string,
): Promise<void> {
  const id = conversationId(accountId, gmailThreadId)
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
