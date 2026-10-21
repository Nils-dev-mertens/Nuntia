/**
 * The provider seam.
 *
 * Everything above this layer is provider-neutral: the conversation model has no
 * idea whether a thread came from Gmail or Microsoft Graph. This file is the
 * contract both adapters implement, and the only shape the sync layer knows.
 *
 * The shapes are deliberately *MIME-shaped* even though Graph is a JSON API.
 * Gmail's structured payload is a MIME tree; Graph's message bodies are HTML and
 * text strings. The Microsoft adapter synthesises the same tree (text part, HTML
 * part, one leaf per attachment) so `toParsedMessage` and the attachment walker
 * have exactly one implementation to be correct about. That is worth more than a
 * perfectly neutral wire type nobody else would use.
 */

/** A connected mailbox's provider. */
export type Provider = 'google' | 'microsoft'

/**
 * Which stored cursor a provider's incremental sync uses.
 *
 * Gmail's cursor is an opaque history id; Graph's is the timestamp it last
 * looked at. Storing them under different kinds means switching a mailbox's
 * semantics never has to interpret another provider's number.
 */
export function cursorKindFor(provider: Provider): 'history' | 'received' {
  return provider === 'google' ? 'history' : 'received'
}

/** A single part from a provider's structured payload. */
export type ProviderPart = {
  partId: string
  mimeType: string
  filename: string | null
  /** base64url body data, absent when the part is empty */
  data?: string
  headers: Record<string, string>
  children: ProviderPart[]
}

/** One message, with its MIME tree. */
export type ProviderMessage = {
  /** The provider's own message id. */
  id: string
  threadId: string
  /** Gmail's label list. Empty for providers that have no labels. */
  labelIds: string[]
  /** Milliseconds since the epoch, as a string (Gmail's own shape). */
  internalDate: string | null
  snippet: string | null
  payload: ProviderPart | null
}

export type ProviderThread = {
  id: string
  /** The cursor value at the time the thread was read, when the provider has one. */
  cursor: string
  messages: ProviderMessage[]
}

/** One page of thread listings. */
export type ThreadListPage = {
  threads: Array<{ id: string; cursor: string }>
  nextPageToken?: string | null
  resultSizeEstimate?: number | null
}

/** One page of changes since a cursor. */
export type HistoryPage = {
  history: Array<{
    id: string
    messages: Array<{ id: string; threadId: string }>
  }>
  nextPageToken?: string | null
  /** The cursor to store after this run. */
  cursor?: string | null
}

export type AttachmentPayload = {
  data: string
  size: number
}

/** What a provider returns after accepting a message. */
export type SendResult = {
  id: string
  threadId: string | null
  labelIds: string[]
}

/**
 * A brand-new message — no thread to join, so no `In-Reply-To`/`References`.
 *
 * The provider builds the wire format: Gmail takes RFC 5322 MIME, Graph takes
 * its own JSON `sendMail`, and the seam is the structured message either way.
 */
export type NewMessagePayload = {
  subject: string
  to: string[]
  cc: string[]
  bcc: string[]
  /** Plain text, exactly as the user wrote it. */
  text: string
  /** Rich alternative derived from the text; never generated on its own. */
  html: string
  attachments: Array<{
    filename: string
    contentType: string
    /** Raw bytes. */
    data: Uint8Array
  }>
}

/** What a composed reply hands the provider when it sends. */
export type ReplyPayload = {
  /** The thread the reply belongs to, in the provider's own id space. */
  threadId: string
  /** RFC 5322 Message-ID of the message being replied to, when known. */
  inReplyTo: string | null
  /** The RFC `References` chain, oldest first. */
  references: string[]
  subject: string
  to: string[]
  cc: string[]
  text: string
  html: string
  attachments: Array<{
    filename: string
    contentType: string
    /** Raw bytes. */
    data: Uint8Array
  }>
}

/**
 * What sync needs from a mailbox.
 *
 * Deliberately narrow, and identical for every provider. A provider that cannot
 * satisfy a method has to say so through a capability rather than by being
 * absent, so callers never branch on which adapter they hold.
 */
export type MailboxCapabilities = {
  /**
   * The provider has its own reply transport (`sendReply` is implemented), so
   * the composed body is handed over instead of being encoded as raw MIME.
   */
  structuredReply: boolean
  /** Changes can be listed from a cursor instead of only by refetching threads. */
  delta: boolean
}

export interface MailboxClient {
  readonly provider: Provider

  readonly capabilities: MailboxCapabilities

  /** Current cursor value, used as the starting point for incremental sync. */
  getProfileHistoryId: () => Promise<string>

  /** List thread ids, newest first. */
  listThreads: (opts: {
    pageToken?: string
    maxResults?: number
    query?: string
  }) => Promise<ThreadListPage>

  /** Fetch a full thread with all message payloads. */
  getThread: (threadId: string) => Promise<ProviderThread>

  /** Changes since a cursor. */
  listHistory: (opts: {
    startHistoryId: string
    pageToken?: string
  }) => Promise<HistoryPage>

  /** Download one attachment's bytes, base64 as the provider returns them. */
  getAttachment: (
    messageId: string,
    attachmentId: string,
  ) => Promise<AttachmentPayload>

  /** The authenticated account's address. */
  getEmailAddress: () => Promise<string>

  /**
   * Send a raw RFC 5322 message.
   *
   * Only the Gmail adapter implements this: Graph has no raw-MIME send that
   * works for both consumer and work accounts, so the Microsoft adapter sends a
   * structured reply through `sendReply` instead.
   */
  sendMessage?: (
    raw: string,
    opts?: { threadId?: string },
  ) => Promise<SendResult>

  /**
   * Send a composed reply through the provider's own message model.
   *
   * The body is already composed — greeting, signature and quote included — so
   * an implementation must use it verbatim rather than generating its own
   * quoted history.
   */
  sendReply?: (payload: ReplyPayload) => Promise<SendResult>

  /**
   * Start a new conversation with one message.
   *
   * Optional for the same reason `sendReply` is: a provider that cannot send
   * says so by not implementing it, and the caller reports that rather than
   * pretending the mail went out.
   */
  sendNewMessage?: (payload: NewMessagePayload) => Promise<SendResult>

  /**
   * Ask the provider to notify this app when the mailbox changes.
   *
   * The registration expires — Gmail's after at most seven days — so the caller
   * stores the expiry and renews before it lapses. Only Gmail implements it;
   * Graph change notifications need their own client state and renewal, so an
   * Outlook mailbox stays on the poll.
   */
  startWatch?: (opts: { topicName: string }) => Promise<{ expiresAt: Date }>
}

/** A client plus the account it belongs to. */
export type Mailbox = {
  provider: Provider
  accountId: string
  client: MailboxClient
}
