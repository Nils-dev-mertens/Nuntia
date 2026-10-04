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
  getParsingProfileContext,
} from '#/lib/conversation/index.ts'
import { MAX_ATTACHMENT_BYTES, safeFilename } from './attachments.ts'
import type { GmailClient } from './client.ts'

export type ReplyAttachmentUpload = {
  filename: string
  contentType: string
  /** Standard base64-encoded bytes from the composer. */
  data: string
}

const MAX_REPLY_ATTACHMENTS = 10
const MAX_ATTACHMENT_BYTES_TOTAL = 18 * 1024 * 1024

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
  client: GmailClient,
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

  if (conversation.isAutomated) {
    throw new ReplyNotPossibleError(
      'This thread has no reply address — it is an automated notification.',
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

  const attachments = decodeReplyAttachments(opts.attachments ?? [])
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
  const { raw } = buildMimeMessage({
    to: recipients,
    cc: [],
    subject: conversation.subject.toLowerCase().startsWith('re:')
      ? conversation.subject
      : `Re: ${conversation.subject}`,
    body: composed.text,
    html: composed.html,
    inReplyTo: last.internetMessageId ?? undefined,
    references,
    attachments,
  })

  const result = await client.sendMessage(raw, {
    threadId: conversation.gmailThreadId,
  })

  return {
    messageId: result.id,
    threadId: result.threadId ?? conversation.gmailThreadId,
  }
}

/** Detect control characters without embedding them in a regular expression. */
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.codePointAt(0) ?? 0
    return code < 32 || code === 127
  })
}

/** Validate and decode untrusted file uploads before composing MIME. */
function decodeReplyAttachments(
  uploads: ReplyAttachmentUpload[],
): Array<{ filename: string; contentType: string; data: Uint8Array }> {
  if (uploads.length > MAX_REPLY_ATTACHMENTS) {
    throw new ReplyNotPossibleError(
      `Attach no more than ${MAX_REPLY_ATTACHMENTS} files per reply.`,
    )
  }

  let totalBytes = 0
  return uploads.map((upload) => {
    if (
      typeof upload.filename !== 'string' ||
      !upload.filename.trim() ||
      upload.filename.length > 255 ||
      hasControlCharacter(upload.filename)
    ) {
      throw new ReplyNotPossibleError('An attachment has an invalid filename.')
    }
    if (
      typeof upload.data !== 'string' ||
      upload.data.length > Math.ceil(MAX_ATTACHMENT_BYTES_TOTAL / 3) * 4 ||
      upload.data.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        upload.data,
      )
    ) {
      throw new ReplyNotPossibleError('An attachment could not be read.')
    }

    const data = Uint8Array.from(Buffer.from(upload.data, 'base64'))
    if (data.byteLength === 0) {
      throw new ReplyNotPossibleError('Empty attachments cannot be sent.')
    }
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new ReplyNotPossibleError(
        `${upload.filename} exceeds the 25 MB per-file limit.`,
      )
    }

    totalBytes += data.byteLength
    if (totalBytes > MAX_ATTACHMENT_BYTES_TOTAL) {
      throw new ReplyNotPossibleError('Attachments must total 18 MB or less.')
    }

    const contentType =
      typeof upload.contentType === 'string' &&
      /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(upload.contentType)
        ? upload.contentType.toLowerCase()
        : 'application/octet-stream'

    return {
      filename: safeFilename(upload.filename),
      contentType,
      data,
    }
  })
}

/**
 * Re-fetch one thread after a send, so the new message shows up immediately.
 *
 * Sending does not touch our database, and the sync cursor has already moved
 * past this thread — so without this the user would send a reply and watch it
 * not appear until some later sync happened to cover it.
 */
export async function refreshThread(
  client: GmailClient,
  accountId: string,
  gmailThreadId: string,
): Promise<void> {
  const thread = await client.getThread(gmailThreadId)
  const relevant = thread.messages.filter(
    (m) => !m.labelIds.includes('DRAFT') && !m.labelIds.includes('TRASH'),
  )

  if (relevant.length === 0) return

  const { buildConversation, saveConversation } =
    await import('#/lib/conversation/index.ts')

  const { toParsedMessage } = await import('./message.ts')

  const profileContext = await getParsingProfileContext(accountId)
  const conversation = buildConversation(relevant.map(toParsedMessage), {
    ownerEmail: accountId,
    gmailThreadId,
    ...profileContext,
  })

  await saveConversation(accountId, conversation)
}

/** Load a conversation or fail with a message the UI can show. */
export async function requireConversation(
  accountId: string,
  gmailThreadId: string,
): Promise<Conversation> {
  const conversation = await getConversation(accountId, gmailThreadId)
  if (!conversation) {
    throw new ReplyNotPossibleError('That conversation no longer exists.')
  }
  return conversation
}
