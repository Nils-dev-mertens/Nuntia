import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

import type { Provider } from '#/lib/mailbox/types.ts'

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

export const ORGANIZATION_RULE_FIELDS = [
  'sender-email',
  'sender-domain',
  'subject-contains',
  'topic-contains',
  'state-is',
] as const

export type OrganizationRuleField = (typeof ORGANIZATION_RULE_FIELDS)[number]

/**
 * The two roles there are.
 *
 * `admin` may open `/admin`; `member` may not. Kept as a column rather than an
 * env-only allowlist so the first user on a fresh install can be promoted
 * without a restart, and so an operator page can name its owner. The env list
 * (`LUMEN_ADMIN_EMAILS`) stays as the break-glass override.
 */
export const USER_ROLES = ['admin', 'member'] as const

export type UserRole = (typeof USER_ROLES)[number]

/**
 * A person who signs in to this install.
 *
 * `id` is the lowercased email address, the same convention accounts use: it is
 * stable, already unique, and makes a session payload readable in a log without
 * a second lookup. Passwords are argon2id hashes (via `hash-wasm`); there is
 * no password reset yet, so losing it means an owner has to re-create the user.
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name'),
    /** argon2id hash. Never the password, and never logged. */
    passwordHash: text('password_hash').notNull(),
    /** `admin` may open `/admin`. An invited user starts as `member`. */
    role: text('role').notNull().default('member').$type<UserRole>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
)

/**
 * A signed-in device.
 *
 * The cookie carries `<session id>.<random token>`; only the SHA-256 of the
 * token is stored. That is what makes sign-out meaningful: deleting the row
 * revokes that device immediately, which a self-contained signed cookie cannot
 * do. Several rows per user is the normal case — a laptop and a phone.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the random token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** Free-text hint, when a client sends one. Never used for authorisation. */
    userAgent: text('user_agent'),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    index('sessions_expires_idx').on(table.expiresAt),
  ],
)

/** A single connected mailbox. More than one is supported; they are merged. */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    /**
     * The person who connected this mailbox.
     *
     * Null only for rows written before user accounts existed, or by tests that
     * do not need one. Production always resolves accounts through a session, so
     * a null owner is unreachable rather than shared.
     */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Which provider the stored token and thread ids belong to.
     *
     * `google` is the default so every existing row keeps working after the
     * migration — the column was added in the same release as the seam, and an
     * un-marked account can only have been a Gmail one.
     */
    provider: text('provider').$type<Provider>().notNull().default('google'),
    /** AES-256-GCM ciphertext of the OAuth refresh token. Never store plaintext. */
    refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),
    accessTokenExpiresAt: integer('access_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    scopes: text('scopes'),
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
     * When the provider's push notification registration expires.
     *
     * Gmail's `users.watch` expires after at most seven days and must be renewed;
     * null means "never registered". Only Gmail fills this in today — Graph
     * subscriptions need their own renewal and are not implemented.
     */
    pushExpiresAt: integer('push_expires_at', { mode: 'timestamp_ms' }),

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
  (table) => [
    uniqueIndex('accounts_email_idx').on(table.email),
    index('accounts_user_idx').on(table.userId),
  ],
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
    providerThreadId: text('provider_thread_id').notNull(),
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
    /**
     * The user's own call on the state, or null when they have made none.
     *
     * The one derived-looking column a decision layer is not allowed to write.
     * The user saying "this is not important" has to outlive every re-decide and
     * every later sync — incremental sync only revisits threads Gmail reports as
     * changed, so a call that is not stored is a call that gets computed away.
     */
    stateOverride: text('state_override').$type<ConversationState>(),
    /**
     * The thread's last activity when the call was made.
     *
     * The call was a judgement about the messages that existed then, so a newer
     * message voids it — the thread comes back for a fresh look rather than
     * staying filed away forever.
     */
    stateOverrideMessageAt: integer('state_override_message_at', {
      mode: 'timestamp_ms',
    }),

    /**
     * The sent time of the newest message the user has seen in this thread.
     *
     * The per-message "viewed" state, stored as one high-water mark rather than a
     * flag per message: `saveConversation` replaces a thread's messages wholesale
     * on every sync, so a column on `messages` would be wiped by the next sync of
     * that thread and the user's reading would silently come undone. Any message
     * older than this mark is one they have seen; anything newer is unread.
     *
     * Viewing is deliberately *not* the same as done: this is set by opening a
     * thread, and it never moves the thread's state or its Done mark, so reading
     * mail can never be mistaken for having dealt with it.
     */
    seenAt: integer('seen_at', { mode: 'timestamp_ms' }),

    /**
     * The user's own "done" mark: when they said this thread was handled, and the
     * thread's last activity at that moment.
     *
     * Only the user sets it — not a sync, not the decision layer, and not opening
     * the thread (that is `seen_at`). That is the point: a thread stays visibly
     * open until something was actually done about it, which is what stops a
     * read-but-unanswered thread from disappearing into the rest.
     */
    doneAt: integer('done_at', { mode: 'timestamp_ms' }),
    /**
     * The thread's `lastMessageAt` when the mark was made.
     *
     * The mark was a judgement about the mail that existed then, so newer mail
     * voids it — the same rule as `stateOverrideMessageAt`, and for the same
     * reason: a Done thread that receives a reply has to come back rather than
     * stay filed away forever.
     */
    doneMessageAt: integer('done_message_at', { mode: 'timestamp_ms' }),

    /**
     * Whether this conversation can be replied to at all.
     *
     * Two steps. The deterministic machine-mail marker settles it first — an
     * address that marks itself no-reply is not replyable. The decision model
     * (Jev) then decides the rest, for "letters" a human sent that still have
     * nobody to answer. False hides the composer and shows the "No reply" tag.
     */
    replyable: integer('replyable', { mode: 'boolean' })
      .notNull()
      .default(true),

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
      table.providerThreadId,
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
    providerMessageId: text('provider_message_id').notNull(),
    internetMessageId: text('internet_message_id'),
    from: text('from', { mode: 'json' }).$type<Participant>().notNull(),
    to: text('to', { mode: 'json' }).$type<Participant[]>().notNull(),
    cc: text('cc', { mode: 'json' })
      .$type<Participant[]>()
      .notNull()
      .default(sql`'[]'`),

    subject: text('subject').notNull(),
    snippet: text('snippet'),
    /** Original provider body parts, retained locally for lossless re-parsing. */
    rawBodyText: text('raw_body_text'),
    rawBodyHtml: text('raw_body_html'),
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
    uniqueIndex('messages_conversation_provider_idx').on(
      table.conversationId,
      table.providerMessageId,
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
    providerAttachmentId: text('provider_attachment_id').notNull(),
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
    uniqueIndex('attachments_message_provider_idx').on(
      table.messageId,
      table.providerAttachmentId,
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

/**
 * What the user has taught the app about one sender.
 *
 * Kept apart from `sender_profiles` on purpose: that table holds preferences
 * the user set (how to parse this sender's mail, how to sign a reply), while
 * this is an inference drawn from what they *did* — they filed a thread from
 * this sender away, or brought one back.
 *
 * Two timestamps rather than a counter, because the most recent thing the user
 * did is the signal that matters: ignoring again re-arms the learning, and a
 * restore switches it off until they file something away again. A counter would
 * make "bring one back" a no-op for a sender filed away more than once.
 */
export const senderSignals = sqliteTable(
  'sender_signals',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    senderEmail: text('sender_email').notNull(),
    /** Last time the user filed a thread from this sender away. */
    ignoredAt: integer('ignored_at', { mode: 'timestamp_ms' }),
    /** Last time the user brought one back and told the app to stop assuming. */
    restoredAt: integer('restored_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex('sender_signals_account_email_idx').on(
      table.accountId,
      table.senderEmail,
    ),
  ],
)

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

    /**
     * Whether a reply can reach this sender at all — the user's own answer.
     *
     * The machine-mail marker and Jev both miss the case this exists for: a
     * company writing from an ordinary address (`updates@`, `account@`) whose
     * mail is view-only, so there is nothing to answer. The user is the only one
     * who can know that, so the flag lives here among the other per-sender
     * preferences they set — and, like `topic` and `goal`, it outranks both: a
     * marked sender's threads are never handed to Jev's replyability question.
     *
     * True by default, so a row saved for parsing or reply style alone changes
     * nothing about replyability. False hides the composer and shows the "No
     * reply" tag on every thread from the address; it deliberately leaves `state`
     * alone — the user is saying they cannot answer, not that it does not matter.
     */
    replyable: integer('replyable', { mode: 'boolean' })
      .notNull()
      .default(true),

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

/**
 * Display names learned from stored mail, per mailbox.
 *
 * The mailbox headers are the only address book this app has: a name is worth
 * keeping once a message has carried it, so a later thread from the same address
 * stays a person rather than an address. Keyed by `(account, address)` because
 * the same person can write to two of the user's mailboxes with two spellings.
 *
 * Names are the *latest* non-empty one seen; a message with only an address
 * never erases a name already learned.
 */
export const contactContexts = sqliteTable(
  'contact_contexts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Normalized email address; shared across this user's connected mailboxes. */
    email: text('email').notNull(),
    roleCompany: text('role_company'),
    relationship: text('relationship'),
    topics: text('topics'),
    currentWork: text('current_work'),
    /** User's 1–10 importance rating for this correspondent; null means unrated. */
    importance: integer('importance'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.email] }),
    index('contact_contexts_email_idx').on(table.email),
  ],
)

export const organizationRules = sqliteTable(
  'organization_rules',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** User-facing name of the custom inbox section. */
    name: text('name').notNull(),
    /**
     * What this label means, in the user's words — shown under the inbox heading
     * so a section explains itself rather than only naming itself.
     */
    description: text('description').notNull().default(''),
    field: text('field').$type<OrganizationRuleField>().notNull(),
    value: text('value').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Lower number wins; array order is preserved by the settings UI. */
    position: integer('position').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index('organization_rules_user_position_idx').on(table.userId, table.position),
  ],
)

/**
 * The user's own wording for the four built-in state labels.
 *
 * The state itself is not theirs to change — the decision layer and every stored
 * row speak in those four values, and a fifth would be a new classification rule
 * rather than a rename. What is theirs is the words: "Needs action" can be
 * "Do this now" and "Waiting for reply" can be "Ball with them". A row exists
 * only for a label the user changed from the default, so improved default copy
 * still reaches anyone who never edited theirs.
 */
export const stateLabels = sqliteTable(
  'state_labels',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    state: text('state').$type<ConversationState>().notNull(),
    /** The label's name, as the user wants it in headings and badges. */
    name: text('name').notNull(),
    /** What the label means and is for. */
    description: text('description').notNull().default(''),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [primaryKey({ columns: [table.userId, table.state] })],
)

export const contacts = sqliteTable(
  'contacts',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Lowercased address. */
    email: text('email').notNull(),
    name: text('name'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.email] }),
    index('contacts_email_idx').on(table.email),
  ],
)

/**
 * Where each mailbox's incremental sync left off, and when.
 *
 * One row per `(account, kind)` because a cursor means different things per
 * provider: Gmail's `historyId` is an opaque counter, Microsoft's is an ISO
 * timestamp, and a future IMAP adapter would store a UID pair. The kind keeps
 * them apart without a column per provider.
 *
 * The timestamp is separate from `accounts.updatedAt` on purpose: that column is
 * also bumped whenever the OAuth token is refreshed, so it cannot answer "when
 * did we last sync?". The staleness check needs exactly that question.
 */
export const syncCursors = sqliteTable(
  'sync_cursors',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** `history` for Gmail, `received` for Microsoft Graph. */
    kind: text('kind').notNull(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.kind] }),
    index('sync_cursors_updated_idx').on(t.updatedAt),
  ],
)

/**
 * Install-wide settings. A single row, id `app`.
 *
 * The AI service credentials live here rather than in `.env`: they are secrets
 * the user sets in the UI, they are per-install, and they are encrypted at rest
 * with the same key as the OAuth refresh tokens. Keeping them out of the
 * environment also means the app can be configured without a redeploy.
 */
export const appSettings = sqliteTable(
  'app_settings',
  {
    id: text('id').primaryKey(),
    /**
     * The person these keys belong to.
     *
     * Per user, not per install: two people on one deployment must not share a
     * paid API key or a reply threshold. Null on the row written before accounts
     * existed, until the bootstrap user adopts it.
     */
    userId: text('user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    /** AES-256-GCM ciphertext of the Jev API key. Never store plaintext. */
    jevApiKeyEncrypted: text('jev_api_key_encrypted'),
    jevModel: text('jev_model'),
    /** One of `anthropic` | `openai` | `gemini`, or null when topics are off. */
    llmProvider: text('llm_provider'),
    llmModel: text('llm_model'),
    /** AES-256-GCM ciphertext of the chosen LLM provider's API key. */
    llmApiKeyEncrypted: text('llm_api_key_encrypted'),
    /**
     * How important a conversation has to be before a draft is offered (1–10).
     *
     * The spec's "importance exceeds a configured threshold", and the reason it is
     * stored rather than hard-coded: a draft costs a paid API call per thread, and
     * what is worth one is the user's call. Compared against the same 1–10 the
     * decision layer scores, so the number on this row and the number on the
     * conversation are the same unit. Default mirrors
     * `REPLY_DRAFT_MIN_IMPORTANCE_DEFAULT` (written out rather than imported, so
     * the schema keeps no dependency on the conversation layer).
     */
    suggestReplyMinImportance: integer('suggest_reply_min_importance')
      .notNull()
      .default(6),
    /**
     * Whether avatars may be fetched from Gravatar.
     *
     * Off by default: the request carries an MD5 of the address to gravatar.com,
     * and a local-first mail client should not contact a third party about who
     * writes to you without being asked. Initials are the fallback either way.
     */
    useGravatar: integer('use_gravatar', { mode: 'boolean' })
      .notNull()
      .default(false),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [uniqueIndex('app_settings_user_idx').on(table.userId)],
)

/**
 * One invite code, issued by an operator.
 *
 * The code itself is never stored — only its SHA-256 — for the same reason a
 * session token is not: a database dump would otherwise be a list of working
 * credentials. `useCount` is a counter rather than a `COUNT(*)` because
 * redemption compares it inside the same `UPDATE` that increments it, which is
 * what makes "single use" true under two simultaneous clicks.
 *
 * `email` is optional. Set, it binds redemption to that address and also makes
 * the invite reusable *by* that address, so a cleared cookie is not a lockout.
 * `notifiedAt` / `notifyError` describe the approval email, not the invite: a
 * failed send must not undo an approval.
 */
export const invites = sqliteTable(
  'invites',
  {
    id: text('id').primaryKey(),
    /** SHA-256 hex of the code. This is what redemption looks codes up by. */
    codeHash: text('code_hash').notNull(),
    /**
     * AES-256-GCM ciphertext of the code, so the operator can copy the link
     * again later.
     *
     * The hash alone cannot produce a link, and "mint a new one" is a poor
     * answer to "what did I send them?". Encrypted rather than plaintext for
     * the same reason refresh tokens are: a database dump should not be a list
     * of working invitations. Null when no `TOKEN_ENCRYPTION_KEY` is set — the
     * invite still works, the link just cannot be shown again.
     */
    codeEncrypted: text('code_encrypted'),
    /** Who it is for, in the operator's words. */
    label: text('label'),
    /** Lowercased. When set, only this address may redeem it. */
    email: text('email'),
    /** Redemptions by a *different* address each consume one. */
    maxUses: integer('max_uses').notNull().default(1),
    useCount: integer('use_count').notNull().default(0),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    /** When a mailbox accepted the approval email. Null means nothing was sent. */
    notifiedAt: integer('notified_at', { mode: 'timestamp_ms' }),
    /** The last send failure; cleared by a successful resend. */
    notifyError: text('notify_error'),
    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex('invites_code_hash_idx').on(table.codeHash),
    index('invites_email_idx').on(table.email),
  ],
)

export const ACCESS_REQUEST_STATUSES = [
  'pending',
  'approved',
  'declined',
  'redeemed',
] as const

export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number]

/**
 * Someone who asked to get in.
 *
 * A row rather than an email, because the answer to "how many people wanted
 * this" has to be countable and because `note` — what they are trying to fix —
 * is the most useful thing a beta collects before anyone has seen the product.
 *
 * The partial unique index is the dedupe rule: one *pending* request per
 * address, while declined and approved rows may repeat over time.
 */
export const accessRequests = sqliteTable(
  'access_requests',
  {
    id: text('id').primaryKey(),
    /** Lowercased; the address the invite will be bound to. */
    email: text('email').notNull(),
    name: text('name'),
    /** "What are you trying to fix?" — required, because it is the signal. */
    note: text('note').notNull(),
    /** How they heard about it, when they say. */
    source: text('source'),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<AccessRequestStatus>(),
    /** Set when the invite is redeemed, by the redemption itself. */
    inviteId: text('invite_id').references(() => invites.id, {
      onDelete: 'set null',
    }),
    decidedBy: text('decided_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    declinedReason: text('declined_reason'),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex('access_requests_pending_email_idx')
      .on(table.email)
      .where(sql`status = 'pending'`),
    index('access_requests_status_idx').on(table.status, table.createdAt),
  ],
)

/**
 * Who used which invite.
 *
 * The code hash cannot answer "which invite produced this person", and the
 * funnel's redemption step needs exactly that. Cascades with the invite and the
 * user, so deleting either leaves no orphan.
 */
export const inviteRedemptions = sqliteTable(
  'invite_redemptions',
  {
    id: text('id').primaryKey(),
    inviteId: text('invite_id')
      .notNull()
      .references(() => invites.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Browser hint only; never used for authorisation. */
    userAgent: text('user_agent'),
    redeemedAt: integer('redeemed_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index('invite_redemptions_invite_idx').on(table.inviteId),
    /** One redemption row per person per invite: re-entering is not a new use. */
    uniqueIndex('invite_redemptions_pair_idx').on(table.inviteId, table.userId),
  ],
)

export const FEEDBACK_STATUSES = [
  'new',
  'read',
  'planned',
  'fixed',
  'declined',
] as const

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

/**
 * What a beta user said got in the way.
 *
 * `context` is the route plus a conversation id when there is one, so a
 * complaint about the composer arrives attached to the thread it happened on.
 * The email is optional and user-supplied: filling it in is permission to reply.
 */
export const feedback = sqliteTable(
  'feedback',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email'),
    /** 1–5, or null when they only wrote something. */
    rating: integer('rating'),
    message: text('message').notNull(),
    /** Route, plus a conversation id when the form was opened from one. */
    context: text('context'),
    status: text('status').notNull().default('new').$type<FeedbackStatus>(),
    resolutionNote: text('resolution_note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index('feedback_status_idx').on(table.status, table.createdAt)],
)

/**
 * The closed list of things that leave no trace in the app's own tables.
 *
 * Everything else in the funnel is derived from rows written for the product's
 * own reasons. This is deliberately an enum in code: a general-purpose tracker
 * is a second copy of the truth, and it drifts.
 */
export const PRODUCT_EVENT_NAMES = [
  'active-day',
  'draft-generated',
  'draft-used',
  'feedback-opened',
  'invite-link-copied',
] as const

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number]

/**
 * One of those events.
 *
 * Never a subject, a sender, a body, a topic, or a third party's address: the
 * row is the user, the event name, a timestamp, and at most a conversation id.
 */
export const productEvents = sqliteTable(
  'product_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull().$type<ProductEventName>(),
    conversationId: text('conversation_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index('product_events_user_idx').on(table.userId, table.createdAt),
    index('product_events_name_idx').on(table.name, table.createdAt),
  ],
)

/**
 * Operator-authored questions.
 *
 * The beta needs to ask different things as it goes — "what got in the way?"
 * today, "would you use this?" next week — so the questions are rows, not code.
 * A form is frozen once it is published: editing it afterwards would make the
 * same prompt mean two things across two weeks, and the answers incomparable.
 */
export const FORM_STATUSES = ['draft', 'open', 'closed'] as const

export type FormStatus = (typeof FORM_STATUSES)[number]

export const FORM_AUDIENCES = ['all', 'selected'] as const

export type FormAudience = (typeof FORM_AUDIENCES)[number]

export const FORM_QUESTION_TYPES = [
  'short-text',
  'long-text',
  'choice',
  'multi-choice',
  'scale',
  'yes-no',
] as const

export type FormQuestionType = (typeof FORM_QUESTION_TYPES)[number]

export const forms = sqliteTable(
  'forms',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').notNull().default('draft').$type<FormStatus>(),
    audience: text('audience').notNull().default('all').$type<FormAudience>(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
    closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [index('forms_status_idx').on(table.status, table.createdAt)],
)

/**
 * One question on a form.
 *
 * `key` is stable for the life of the form and names the answer's CSV column;
 * reordering moves `position`, not the key. `options` holds a JSON array of
 * strings for `choice` and `multi-choice`; `scale` is fixed 1–5 with optional
 * endpoint labels, so there are no numbers to validate beyond the range.
 */
export const formQuestions = sqliteTable(
  'form_questions',
  {
    id: text('id').primaryKey(),
    formId: text('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    position: integer('position').notNull(),
    type: text('type').notNull().$type<FormQuestionType>(),
    prompt: text('prompt').notNull(),
    help: text('help'),
    required: integer('required', { mode: 'boolean' }).notNull().default(false),
    options: text('options_json'),
    scaleLowLabel: text('scale_low_label'),
    scaleHighLabel: text('scale_high_label'),
  },
  (table) => [
    uniqueIndex('form_questions_form_key_idx').on(table.formId, table.key),
    index('form_questions_form_position_idx').on(table.formId, table.position),
  ],
)

/** The people a `selected` form is for. Ignored when the audience is `all`. */
export const formAudience = sqliteTable(
  'form_audience',
  {
    formId: text('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.formId, table.userId] })],
)

/**
 * Whether one person saw, dismissed or answered a form.
 *
 * This is the denominator: "three answers" and "three answers out of forty who
 * saw the banner" are different facts about the beta.
 */
export const formParticipation = sqliteTable(
  'form_participation',
  {
    formId: text('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    shownAt: integer('shown_at', { mode: 'timestamp_ms' }),
    dismissedAt: integer('dismissed_at', { mode: 'timestamp_ms' }),
    submittedAt: integer('submitted_at', { mode: 'timestamp_ms' }),
  },
  (table) => [primaryKey({ columns: [table.formId, table.userId] })],
)

/** One response per person per form, editable until the form closes. */
export const formResponses = sqliteTable(
  'form_responses',
  {
    id: text('id').primaryKey(),
    formId: text('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    submittedAt: integer('submitted_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex('form_responses_form_user_idx').on(table.formId, table.userId),
    index('form_responses_form_idx').on(table.formId, table.submittedAt),
  ],
)

/** The typed answer to one question; the column used depends on its type. */
export const formAnswers = sqliteTable(
  'form_answers',
  {
    id: text('id').primaryKey(),
    responseId: text('response_id')
      .notNull()
      .references(() => formResponses.id, { onDelete: 'cascade' }),
    questionId: text('question_id')
      .notNull()
      .references(() => formQuestions.id, { onDelete: 'cascade' }),
    valueText: text('value_text'),
    valueNumber: integer('value_number'),
    valueChoices: text('value_choices_json'),
  },
  (table) => [
    uniqueIndex('form_answers_response_question_idx').on(
      table.responseId,
      table.questionId,
    ),
  ],
)

export type User = typeof users.$inferSelect
export type Invite = typeof invites.$inferSelect
export type AccessRequest = typeof accessRequests.$inferSelect
export type InviteRedemption = typeof inviteRedemptions.$inferSelect
export type Feedback = typeof feedback.$inferSelect
export type Form = typeof forms.$inferSelect
export type FormQuestion = typeof formQuestions.$inferSelect
export type FormResponse = typeof formResponses.$inferSelect
export type FormAnswer = typeof formAnswers.$inferSelect
export type Session = typeof sessions.$inferSelect
export type Account = typeof accounts.$inferSelect
export type AppSettings = typeof appSettings.$inferSelect
export type Conversation = typeof conversations.$inferSelect
export type Message = typeof messages.$inferSelect
export type Attachment = typeof attachments.$inferSelect
export type SenderProfile = typeof senderProfiles.$inferSelect
export type SenderSignal = typeof senderSignals.$inferSelect
export type Contact = typeof contacts.$inferSelect
export type ContactContext = typeof contactContexts.$inferSelect
export type OrganizationRuleRow = typeof organizationRules.$inferSelect
export type FormParticipation = typeof formParticipation.$inferSelect
export type Decision = typeof decisions.$inferSelect
