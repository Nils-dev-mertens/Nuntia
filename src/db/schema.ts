import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/**
 * Conversation state. The four MVP states from the spec.
 * `low-priority` reuses destructive styling, per PLAN.md.
 */
export const CONVERSATION_STATES = [
  'needs-action',
  'waiting-for-reply',
  'informational',
  'low-priority',
] as const

export type ConversationState = (typeof CONVERSATION_STATES)[number]

export const INTENTS = [
  'request',
  'response',
  'proposal',
  'update',
  'scheduling',
  'transactional',
  'promotion',
  'social',
  'unknown',
] as const

export type Intent = (typeof INTENTS)[number]

/** A single connected Gmail account. MVP assumes one, but the schema allows many. */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    /** AES-256-GCM ciphertext of the OAuth refresh token. Never store plaintext. */
    refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),
    accessTokenExpiresAt: integer('access_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    scopes: text('scopes'),
    historyId: text('history_id'),
    /** Account-wide reply-style defaults; sender profiles may override them. */
    defaultReplyGreeting: text('default_reply_greeting'),
    defaultReplySignature: text('default_reply_signature'),
    defaultStripQuotedHistory: integer('default_strip_quoted_history', {
      mode: 'boolean',
    })
      .notNull()
      .default(true),
    defaultStripGreeting: integer('default_strip_greeting', {
      mode: 'boolean',
    })
      .notNull()
      .default(true),
    defaultStripSignature: integer('default_strip_signature', {
      mode: 'boolean',
    })
      .notNull()
      .default(true),

    /**
     * Which revision of the derived fields this account's conversations reflect.
     *
     * Incremental sync only revisits threads Gmail reports as changed, so a
     * newly added derived column (`is_automated`, later `topic`) would otherwise
     * keep its migration default forever — silently, with no error. Bump
     * `DERIVED_VERSION` in repository.ts and existing rows are recomputed from
     * the stored messages on the next load.
     */
    derivedVersion: integer('derived_version').notNull().default(0),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [uniqueIndex('accounts_email_idx').on(table.email)],
)

/**
 * A Gmail thread, treated as a conversation with state.
 *
 * `topic` and `goal` are user-owned. The goal is the source of truth for intent;
 * `state` may be overwritten by the decision layer but is always user-overridable.
 */
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    gmailThreadId: text('gmail_thread_id').notNull(),
    subject: text('subject').notNull(),
    /** Normalized participants, JSON array of {name, email}. */
    participants: text('participants', { mode: 'json' })
      .$type<Participant[]>()
      .notNull()
      .default(sql`'[]'`),

    state: text('state')
      .$type<ConversationState>()
      .notNull()
      .default('informational'),
    /** True when the last message in the thread was sent by the account owner. */
    awaitingReply: integer('awaiting_reply', { mode: 'boolean' })
      .notNull()
      .default(false),

    /** Short human-readable description of what the conversation is about now. */
    topic: text('topic'),
    /** User-defined description of what they want to accomplish. User-owned. */
    goal: text('goal'),

    importance: integer('importance').notNull().default(5),
    urgency: integer('urgency').notNull().default(5),
    requiresReply: integer('requires_reply', { mode: 'boolean' })
      .notNull()
      .default(false),
    intent: text('intent').$type<Intent>().notNull().default('unknown'),

    messageCount: integer('message_count').notNull().default(0),
    attachmentCount: integer('attachment_count').notNull().default(0),
    isStarred: integer('is_starred', { mode: 'boolean' })
      .notNull()
      .default(false),
    isMuted: integer('is_muted', { mode: 'boolean' }).notNull().default(false),
    isArchived: integer('is_archived', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * No human on the other side — every message came from the owner or a no-reply
     * sender. Derived on every sync from the messages, never edited by hand, so a
     * thread that gains a human reply reverts to chat view by itself.
     */
    isAutomated: integer('is_automated', { mode: 'boolean' })
      .notNull()
      .default(false),

    lastMessageAt: integer('last_message_at', {
      mode: 'timestamp_ms',
    }).notNull(),
    /** Bumped whenever the decision layer writes, so the UI can invalidate. */
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex('conversations_account_thread_idx').on(
      table.accountId,
      table.gmailThreadId,
    ),
    index('conversations_state_idx').on(table.accountId, table.state),
    index('conversations_last_message_idx').on(table.lastMessageAt),
  ],
)

/**
 * One message inside a conversation. `bodyText` holds the *stripped* body
 * (greetings, signatures, and quoted history removed) — the chat-view content.
 * The raw MIME stays in Gmail; we only cache what we render.
 */
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    gmailMessageId: text('gmail_message_id').notNull(),
    internetMessageId: text('internet_message_id'),
    from: text('from', { mode: 'json' }).$type<Participant>().notNull(),
    to: text('to', { mode: 'json' }).$type<Participant[]>().notNull(),
    cc: text('cc', { mode: 'json' })
      .$type<Participant[]>()
      .notNull()
      .default(sql`'[]'`),

    subject: text('subject').notNull(),
    snippet: text('snippet'),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),
    /** Plaintext signature block detected on this message, re-added on reply. */
    signatureText: text('signature_text'),
    /**
     * Greeting detected on this message, e.g. "Hi Sarah,".
     *
     * Stored for the same reason as the signature: it is hidden on display but
     * restored when replying, so a reply does not silently lose it.
     */
    greetingText: text('greeting_text'),
    detectedGreetingText: text('detected_greeting_text'),
    detectedSignatureText: text('detected_signature_text'),
    strippedQuote: text('stripped_quote'),

    sentAt: integer('sent_at', { mode: 'timestamp_ms' }).notNull(),
    isFromAccountOwner: integer('is_from_account_owner', { mode: 'boolean' })
      .notNull()
      .default(false),
    isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex('messages_conversation_gmail_idx').on(
      table.conversationId,
      table.gmailMessageId,
    ),
    index('messages_conversation_sent_idx').on(
      table.conversationId,
      table.sentAt,
    ),
  ],
)

/** Attachments stay in Gmail; we cache metadata and a local path only if fetched. */
export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    gmailAttachmentId: text('gmail_attachment_id').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    /** Byte size as reported by Gmail. */
    sizeBytes: integer('size_bytes').notNull().default(0),
    /** Inline images render as previews; attachments render as a chip. */
    isInline: integer('is_inline', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** Optional local cache path; absent means "fetch on demand". */
    localPath: text('local_path'),
    contentId: text('content_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex('attachments_message_gmail_idx').on(
      table.messageId,
      table.gmailAttachmentId,
    ),
    index('attachments_conversation_idx').on(table.conversationId),
  ],
)

/**
 * Audit trail of decision-layer output. Kept append-only so we can inspect why a
 * conversation was classified the way it was — and diff it when Jev replaces the
 * initial structured-output implementation.
 */
export const decisions = sqliteTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Which implementation produced this: 'llm' today, 'jev' later. */
    provider: text('provider').notNull().default('llm'),
    model: text('model'),
    state: text('state').$type<ConversationState>().notNull(),
    importance: integer('importance').notNull(),
    urgency: integer('urgency').notNull(),
    requiresReply: integer('requires_reply', { mode: 'boolean' }).notNull(),
    intent: text('intent').$type<Intent>().notNull(),
    topic: text('topic'),
    /** Reasoning trace, for debugging classification quality. */
    reasoning: text('reasoning'),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index('decisions_conversation_idx').on(
      table.conversationId,
      table.decidedAt,
    ),
  ],
)

export type Participant = {
  name?: string | null
  email: string
}

/** Gmail history.list gives us deltas; this records where each account's cursor is. */
/** Per-sender parsing and reply-style preferences owned by an account. */
export const senderProfiles = sqliteTable(
  'sender_profiles',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    senderEmail: text('sender_email').notNull(),
    stripQuotedHistory: integer('strip_quoted_history', { mode: 'boolean' })
      .notNull()
      .default(true),
    stripGreeting: integer('strip_greeting', { mode: 'boolean' })
      .notNull()
      .default(true),
    stripSignature: integer('strip_signature', { mode: 'boolean' })
      .notNull()
      .default(true),
    useAccountParsingDefaults: integer('use_account_parsing_defaults', {
      mode: 'boolean',
    })
      .notNull()
      .default(false),
    /** When false, reply style inherits account defaults / the user's own mail. */
    replyStyleEnabled: integer('reply_style_enabled', { mode: 'boolean' })
      .notNull()
      .default(false),
    replyGreeting: text('reply_greeting'),
    replySignature: text('reply_signature'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex('sender_profiles_account_email_idx').on(
      table.accountId,
      table.senderEmail,
    ),
  ],
)

/** Gmail history.list gives us deltas; this records where each account's cursor is. */
export const historyCursors = sqliteTable(
  'history_cursors',
  {
    accountId: text('account_id')
      .primaryKey()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    historyId: text('history_id').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('history_cursors_updated_idx').on(t.updatedAt)],
)

export type Account = typeof accounts.$inferSelect
export type Conversation = typeof conversations.$inferSelect
export type Message = typeof messages.$inferSelect
export type Attachment = typeof attachments.$inferSelect
export type SenderProfile = typeof senderProfiles.$inferSelect
export type Decision = typeof decisions.$inferSelect
