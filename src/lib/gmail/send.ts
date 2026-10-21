/**
 * Sending a reply.
 *
 * The UI hands over a bare body — the text inside a chat bubble, with no
 * greeting, no signature and no quoted history. This module turns that back into
 * an email that looks like every other one the user has sent: greeting restored,
 * signature restored, thread quoted, and the RFC 5322 linkage headers that make
 * other mail clients thread it correctly.
 *
 * That restoration is the whole point of the parser. If it did not strip the
 * greeting on the way in, it would be duplicated here.
 */

import type {
  Conversation,
  ConversationMessage,
} from '#/lib/conversation/index.ts'

import { buildMimeMessage, composeReply } from '#/lib/mail/index.ts'
import {
  getConversation,
  getConversationClusterByThreadId,
  getParsingProfileContext,
  mergeAccountConversations,
} from '#/lib/conversation/index.ts'
import { listAccounts } from '#/lib/auth/accounts.ts'
import type { MailboxClient } from '#/lib/gmail/client.ts'
import { decodeAttachmentUploads } from '#/lib/mailbox/attachment-uploads.ts'
import type { AttachmentUpload } from '#/lib/mailbox/attachment-uploads.ts'

/** Kept as the name callers already use; the validation is shared with new mail. */
export type ReplyAttachmentUpload = AttachmentUpload

export type SendReplyResult = {
  messageId: string
  threadId: string
}

/** Raised when a reply cannot be composed — surfaced to the user verbatim. */
export class ReplyNotPossibleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplyNotPossibleError'
  }
}

/**
 * The user's own most recent message in the thread.
 *
 * Its greeting and signature are the ones they actually use with these people,
 * which beats guessing. Returns null when they have never written in the thread,
 * in which case the reply simply has neither.
 */
function lastMessageFromOwner(
  messages: ConversationMessage[],
  ownerEmail: string,
): ConversationMessage | null {
  const owner = ownerEmail.toLowerCase()

  for (let i = messages.length - 1; i >= 0; i--) {
    // `.at(i)` rather than `[i]`: the index form is typed `T` without
    // `noUncheckedIndexedAccess`, which hides the out-of-bounds case from both
    // the type checker and the linter.
    const message = messages.at(i)
    if (message && message.from.email.toLowerCase() === owner) return message
  }

  return null
}

/**
 * Who to send to.
 *
 * Everyone who has appeared on the thread except the owner — which is what
 * "reply all" means when you are one of the participants.
 *
 * Taken from the conversation's participant list rather than any single
 * message's `To:` header. Reading one message is fragile: if the most recent
 * message is your own and you replied to just one person, trusting its header
 * silently drops everyone else who is still on the thread. The participant list
 * is the union across every message, so nobody is lost.
 */
function recipientsOf(
  participants: Conversation['participants'],
  ownerEmail: string,
): string[] {
  const owner = ownerEmail.toLowerCase()

  return [
    ...new Set(
      participants
        .map((p) => p.email)
        .filter((email) => email.length > 0 && email.toLowerCase() !== owner),
    ),
  ]
}

/** Every RFC Message-ID in the thread, oldest first — the `References` chain. */
function referenceChain(messages: ConversationMessage[]): string[] {
  return messages
    .map((m) => m.internetMessageId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/**
 * Compose and send a reply.
 *
 * `threadId` is passed to Gmail so the message lands in the existing thread.
 * `In-Reply-To` and `References` are set as well — Gmail tolerates either, but
 * Outlook and Apple Mail need the headers to thread it correctly, and a reply
 * that arrives as a loose message is the most visible possible bug in a
 * mail client.
 */
export async function sendReply(
  client: MailboxClient,
  accountId: string,
  conversation: Conversation,
  body: string,
  opts: {
    quoteOriginal?: boolean
    attachments?: ReplyAttachmentUpload[]
    replyStyle?: { greeting: string | null; signature: string | null }
  } = {},
): Promise<SendReplyResult> {
  const trimmed = body.trim()
  if (!trimmed && !opts.attachments?.length) {
    throw new ReplyNotPossibleError('Cannot send an empty reply.')
  }

  if (!conversation.replyable) {
    throw new ReplyNotPossibleError(
      conversation.isAutomated
        ? 'This thread has no reply address — it is an automated notification.'
        : 'This conversation has no address to reply to.',
    )
  }

  const messages = conversation.messages
  const last = messages.at(-1)
  if (!last) {
    throw new ReplyNotPossibleError('This thread has no messages to reply to.')
  }

  const recipients = recipientsOf(conversation.participants, accountId)
  if (recipients.length === 0) {
    throw new ReplyNotPossibleError(
      'No recipient could be determined for this thread.',
    )
  }

  const attachments = decodeAttachmentUploads(opts.attachments ?? [], 'reply')
  const mine = lastMessageFromOwner(messages, accountId)
  const incoming = messages.filter((message) => !message.isFromOwner).at(-1)
  const replyGreeting = opts.replyStyle
    ? opts.replyStyle.greeting
    : (incoming?.replyGreeting ?? mine?.greeting ?? null)
  const replySignature = opts.replyStyle
    ? opts.replyStyle.signature
    : (incoming?.replySignature ?? mine?.signature ?? null)

  // Quoting uses the newest message as the original, so the attribution line
  // reads "On <date> Alice wrote:" rather than quoting the user. Guarded non-null
  // by the check above, and automated threads have already returned.
  const composed = composeReply({
    body: trimmed,
    greeting: replyGreeting,
    signature: replySignature,
    quoteOriginal: opts.quoteOriginal ?? true,
    original: {
      subject: last.subject,
      from: last.from.name ?? last.from.email,
      to: recipients,
      cc: [],
      date: last.sentAt,
      // `last.body` is the *stripped* body: quotes, greeting and signature
      // already removed. Quoting it verbatim is what sent the recipient a wall
      // of `>` lines describing a newsletter layout rather than the newsletter.
      // `originalHtml` below is what the rich part quotes instead.
      parts: [{ contentType: 'text/plain', text: last.body }],
    },
    // Already sanitised and quote-stripped at parse time, so it is safe to embed
    // verbatim inside the reply's `<blockquote>`.
    originalHtml: last.bodyHtml,
  })

  const references = referenceChain(messages)
  const subject = conversation.subject.toLowerCase().startsWith('re:')
    ? conversation.subject
    : `Re: ${conversation.subject}`

  // Providers that model a reply rather than a raw message get the composed
  // body and let their own API thread it. Graph is the one that does: its
  // `createReply` is what keeps the message in the conversation, and writing the
  // body over the draft is what stops it from quoting the original a second time.
  if (client.sendReply) {
    const result = await client.sendReply({
      threadId: conversation.providerThreadId,
      inReplyTo: last.internetMessageId ?? null,
      references,
      subject,
      to: recipients,
      cc: [],
      text: composed.text,
      // Graph's reply body is HTML only. Composition always produces one in
      // practice; the fallback keeps a plain-text body sendable rather than
      // dropping it.
      html:
        composed.html ??
        `<p>${escapeHtml(composed.text).replace(/\n/g, '<br>')}</p>`,
      attachments,
    })

    return {
      messageId: result.id,
      threadId: result.threadId ?? conversation.providerThreadId,
    }
  }

  const { raw } = buildMimeMessage({
    to: recipients,
    cc: [],
    subject,
    body: composed.text,
    html: composed.html,
    inReplyTo: last.internetMessageId ?? undefined,
    references,
    attachments,
  })

  if (!client.sendMessage) {
    throw new ReplyNotPossibleError('This mailbox cannot send a reply.')
  }

  const result = await client.sendMessage(raw, {
    threadId: conversation.providerThreadId,
  })

  return {
    messageId: result.id,
    threadId: result.threadId ?? conversation.providerThreadId,
  }
}

/** Escape text for the plain-text fallback body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Re-fetch one thread after a send, so the new message shows up immediately.
 *
 * Sending does not touch our database, and the sync cursor has already moved
 * past this thread — so without this the user would send a reply and watch it
 * not appear until some later sync happened to cover it.
 */
export async function refreshThread(
  client: MailboxClient,
  accountId: string,
  providerThreadId: string,
): Promise<void> {
  const thread = await client.getThread(providerThreadId)
  const relevant = thread.messages.filter(
    (m) => !m.labelIds.includes('DRAFT') && !m.labelIds.includes('TRASH'),
  )

  if (relevant.length === 0) return

  const {
    buildConversation,
    getStoredUserFields,
    listUnreplyableSenders,
    otherPartyOf,
    saveConversation,
  } = await import('#/lib/conversation/index.ts')

  const { toParsedMessage, toThreadAttachmentRefs } =
    await import('#/lib/mailbox/message.ts')

  const profileContext = await getParsingProfileContext(accountId)
  const parsed = relevant.map(toParsedMessage)
  const conversation = buildConversation(parsed, {
    ownerEmail: accountId,
    providerThreadId,
    // Rebuilt without these, the conversation claimed to have no attachments —
    // and since saving replaces the messages wholesale, the attachment rows
    // went with them and the chips vanished until a later sync restored them.
    attachments: toThreadAttachmentRefs(relevant, parsed),
    ...profileContext,
  })

  // `buildConversation` derives replyability from the machine-mail marker alone,
  // and this path deliberately does not run the decision layer (a send must not
  // cost a Jev call). The user's own answer about this sender is read back and
  // kept for that reason: the column is partly theirs now, and re-deriving it
  // here would put a composer back on a thread they marked.
  const sender = otherPartyOf(conversation)
  const marked =
    sender !== '' && (await listUnreplyableSenders(accountId)).has(sender)

  // Reading and the Done mark are the user's too, and this is the quietest place
  // they could be lost: the reply just sent is a new message, so saving without
  // them would reset `seen_at` and hand back a thread the user had finished with
  // — seconds after they sent the message that finished it.
  const storedUserFields = await getStoredUserFields(
    accountId,
    providerThreadId,
  )

  await saveConversation(accountId, {
    ...conversation,
    ...storedUserFields,
    replyable: marked ? false : conversation.replyable,
  })
}

/** Load a conversation or fail with a message the UI can show. */
export async function requireConversation(
  accountId: string,
  providerThreadId: string,
): Promise<Conversation> {
  const conversation = await getConversation(accountId, providerThreadId)
  if (!conversation) {
    throw new ReplyNotPossibleError('That conversation no longer exists.')
  }
  return conversation
}

/**
 * Load a conversation by thread id, whichever mailbox owns it.
 *
 * The inbox spans several accounts, so an action triggered from the conversation
 * view cannot assume the session's account — the reply must leave from the
 * mailbox the thread actually belongs to. The account id comes back with the
 * conversation for exactly that reason.
 *
 * Resolves the same Message-ID-connected cluster the detail view renders, not
 * one mailbox's fragment. A reply must quote and address the whole conversation:
 * the stored thread this id names can be a single message when Gmail split the
 * thread differently across two of the user's mailboxes.
 */
export async function requireConversationByThreadId(
  userId: string,
  providerThreadId: string,
): Promise<{ accountId: string; conversation: Conversation }> {
  const cluster = await getConversationClusterByThreadId(
    userId,
    providerThreadId,
  )
  if (!cluster || cluster.length === 0) {
    throw new ReplyNotPossibleError('That conversation no longer exists.')
  }

  const accounts = (await listAccounts(userId)).map((account) => ({
    id: account.id,
    email: account.email,
  }))
  const merged = mergeAccountConversations(cluster, accounts).at(0)
  if (!merged) {
    throw new ReplyNotPossibleError('That conversation no longer exists.')
  }

  return { accountId: merged.ownerAccountId, conversation: merged.conversation }
}
