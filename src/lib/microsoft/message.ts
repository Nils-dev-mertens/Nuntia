/**
 * Graph message → the neutral provider message.
 *
 * Graph is a JSON API, but everything above the mailbox seam reads one
 * MIME-shaped tree. Synthesising that tree here — a text part, an HTML part, and
 * one leaf per attachment — is what lets the parser, the attachment walker and
 * the conversation model stay untouched. The alternative, a second body decoder
 * for Graph, would be a second place to get quoting and charset handling wrong.
 *
 * Graph has no label list and no in-message Bcc header; drafts are the only
 * exclusion, expressed as Gmail's `DRAFT` label so the sync filter stays one
 * rule. Trash is a folder, not a message flag, and the listing excludes deleted
 * items by default.
 */

import type { ProviderMessage, ProviderPart } from '#/lib/mailbox/types.ts'

/** Just enough of Graph's message shape to build a bubble. */
export type GraphRecipient = {
  emailAddress?: { name?: string | null; address?: string | null } | null
}

export type GraphAttachment = {
  id: string
  name?: string | null
  contentType?: string | null
  size?: number | null
  isInline?: boolean | null
  contentId?: string | null
}

export type GraphMessage = {
  id: string
  conversationId?: string | null
  internetMessageId?: string | null
  subject?: string | null
  body?: { contentType?: string | null; content?: string | null } | null
  bodyPreview?: string | null
  from?: GraphRecipient | null
  toRecipients?: GraphRecipient[] | null
  ccRecipients?: GraphRecipient[] | null
  bccRecipients?: GraphRecipient[] | null
  receivedDateTime?: string | null
  sentDateTime?: string | null
  isDraft?: boolean | null
  hasAttachments?: boolean | null
  attachments?: GraphAttachment[] | null
}

/** `Name <address>` as the parser's `from`/`to` headers expect. */
function formatRecipient(recipient: GraphRecipient | null | undefined): string {
  const address = recipient?.emailAddress?.address?.trim()
  if (!address) return ''

  const name = recipient?.emailAddress?.name?.trim()
  return name ? `${name} <${address}>` : address
}

function formatRecipients(
  recipients: GraphRecipient[] | null | undefined,
): string {
  return (recipients ?? [])
    .map(formatRecipient)
    .filter((value) => value.length > 0)
    .join(', ')
}

/** base64url as the neutral tree's text parts carry. */
function encodeBody(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64url')
}

/**
 * One attachment leaf.
 *
 * The `x-` headers are the neutral tree's contract with `collectAttachments`:
 * the Gmail adapter fills them from Gmail's MIME part, and Graph fills them from
 * its attachment metadata. The bytes are not here for either — they are fetched
 * on demand when a chip is opened.
 */
function attachmentPart(attachment: GraphAttachment): ProviderPart {
  const headers: Record<string, string> = {
    'x-attachment-id': attachment.id,
    'x-attachment-size': String(attachment.size ?? 0),
    'content-disposition': attachment.isInline ? 'inline' : 'attachment',
  }
  if (attachment.contentId) {
    headers['content-id'] = `<${attachment.contentId}>`
  }

  return {
    partId: attachment.id,
    mimeType: attachment.contentType ?? 'application/octet-stream',
    filename: attachment.name ?? 'attachment',
    headers,
    children: [],
  }
}

/**
 * Convert one Graph message.
 *
 * `attachments` is passed in rather than read from the message: Graph only
 * returns attachment metadata when the request asks for the expansion, and the
 * client owns that request shape.
 */
export function toProviderMessage(
  message: GraphMessage,
  attachments: GraphAttachment[] = message.attachments ?? [],
): ProviderMessage {
  const parts: ProviderPart[] = []
  const body = message.body?.content ?? ''

  if (body) {
    const isHtml = message.body?.contentType?.toLowerCase() === 'html'

    parts.push({
      partId: 'body',
      mimeType: isHtml ? 'text/html' : 'text/plain',
      filename: null,
      data: encodeBody(body),
      headers: isHtml
        ? { 'content-type': 'text/html; charset="utf-8"' }
        : { 'content-type': 'text/plain; charset="utf-8"' },
      children: [],
    })
  }

  const headers: Record<string, string> = {
    subject: message.subject ?? '',
    from: formatRecipient(message.from),
    'message-id': message.internetMessageId ?? message.id,
  }

  const to = formatRecipients(message.toRecipients)
  if (to) headers.to = to
  const cc = formatRecipients(message.ccRecipients)
  if (cc) headers.cc = cc

  const received = message.receivedDateTime ?? message.sentDateTime
  if (received) headers.date = received

  return {
    id: message.id,
    threadId: message.conversationId ?? message.id,
    // Graph's only exclusion is a draft. Reusing Gmail's label keeps the sync
    // filter a single rule for both providers.
    labelIds: message.isDraft ? ['DRAFT'] : [],
    internalDate: received ? String(Date.parse(received)) : null,
    snippet: message.bodyPreview ?? null,
    payload: {
      partId: 'root',
      mimeType: 'multipart/alternative',
      filename: null,
      headers,
      children: [...parts, ...attachments.map(attachmentPart)],
    },
  }
}
