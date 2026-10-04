/**
 * Gmail message → ParsedMessage.
 *
 * Gmail's structured payload is a MIME tree rather than raw RFC822, so it cannot
 * go straight through postal-mime. This module walks the tree and produces the
 * same `ParsedMessage` shape the rest of the app already consumes — that is the
 * whole point: the conversation model never learns where mail came from.
 */

import type { ParsedMessage } from '#/lib/mail/index.ts'

import type { GmailMessage, GmailPart } from './client.ts'

/** An attachment found in the tree, before any download. */
export type GmailAttachmentRef = {
  /** The Gmail part id, used to fetch the bytes later. */
  attachmentId: string
  filename: string
  mimeType: string
  /** Bytes as reported by Gmail, from the header tree. */
  sizeBytes: number
  contentId: string | null
  isInline: boolean
}

/**
 * Decode Gmail's base64url body data.
 *
 * Gmail omits padding and uses the URL-safe alphabet, so `Buffer.from(s, 'base64')`
 * alone silently produces corrupt output on some inputs.
 */
export function decodeGmailData(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/** Decode a part's text using its declared charset. */
function decodeText(part: LooseGmailPart): string {
  if (!part.data) return ''

  const bytes = decodeGmailData(part.data)

  // Body parts are UTF-8 in practice. Decoding strictly and falling back avoids
  // throwing on a mislabeled legacy message.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/**
 * A payload part as it may actually arrive: Gmail omits `children` on leaf
 * parts, and `headers` can be missing on a malformed payload. The declared
 * `GmailPart` type says otherwise, so every tree walk takes this looser view.
 */
type LooseGmailPart = Omit<GmailPart, 'children' | 'headers'> & {
  children?: LooseGmailPart[]
  // Gmail's part headers are sparse: any given key may simply be absent.
  headers?: Record<string, string | undefined>
}

/**
 * Depth-first search for the first part matching a predicate.
 *
 * Tolerates parts without a `children` array — Gmail omits it for leaf parts,
 * and a caller may pass a tree that never went through `toGmailPart`.
 */
function findPart(
  part: LooseGmailPart | undefined | null,
  predicate: (p: LooseGmailPart) => boolean,
): LooseGmailPart | null {
  if (!part) return null
  if (predicate(part)) return part

  for (const child of part.children ?? []) {
    const found = findPart(child, predicate)
    if (found) return found
  }

  return null
}

/** Collect every leaf part that is an attachment or inline image. */
function collectAttachments(
  part: LooseGmailPart,
  out: GmailAttachmentRef[] = [],
): GmailAttachmentRef[] {
  const contentDisposition = part.headers?.['content-disposition'] ?? ''
  const hasFilename = typeof part.filename === 'string' && part.filename.length > 0
  const isAttachment =
    /attachment/i.test(contentDisposition) || hasFilename
  const isInlineImage =
    /inline/i.test(contentDisposition) &&
    part.mimeType.startsWith('image/')

  if ((isAttachment || isInlineImage) && part.partId) {
    const attachmentId = part.headers?.['x-attachment-id']

    if (attachmentId) {
      const contentId = part.headers?.['content-id'] ?? null

      out.push({
        attachmentId,
        filename: part.filename || fallbackFilename(part.mimeType),
        mimeType: part.mimeType,
        sizeBytes: parseInt(part.headers?.['x-attachment-size'] ?? '0', 10) || 0,
        contentId: contentId ? stripAngleBrackets(contentId) : null,
        isInline: /inline/i.test(contentDisposition),
      })
    }
  }

  for (const child of part.children ?? []) {
    collectAttachments(child, out)
  }

  return out
}

/** Build a readable filename when the part has none. */
function fallbackFilename(mimeType: string): string {
  const subtype = mimeType.split('/')[1] ?? 'file'
  return `attachment.${subtype.split('+')[0]}`
}

/**
 * Strip the angle brackets from a Message-ID or address-list token.
 *
 * Note this operates on the *token*, not the whole header — a From header is
 * `Sarah <sarah@example.com>`, and stripping brackets from the whole string
 * would leave the trailing `>` behind because it is not at the end.
 */
function stripAngleBrackets(value: string): string {
  return value.trim().replace(/^</, '').replace(/>$/, '')
}

/**
 * Extract a bare address from a header value.
 *
 * Gmail returns `Sarah Chen <sarah@example.com>`; the conversation model wants
 * just the address so it can compare against the account owner.
 */
function extractAddress(header: string | undefined): string {
  if (!header) return ''

  const angled = header.match(/<([^>]+)>/)
  if (angled) return angled[1].trim()

  return stripAngleBrackets(header.split(',')[0] ?? '')
}

/** Find the To header and split addresses. */
function addressesFrom(header: string | undefined): string[] {
  if (!header) return []

  return header
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
}

/**
 * Convert a Gmail message into a `ParsedMessage`.
 *
 * Prefers `text/plain` because its quoting is already normalised and strips
 * more reliably; falls back to `text/html`, which the DOM extractor handles.
 */
export function toParsedMessage(message: GmailMessage): ParsedMessage {
  const root: LooseGmailPart | null = message.payload

  // `root` may be null and `headers` may be absent on a malformed payload, so
  // both levels need guarding — `root?.headers[name]` only handles the first.
  const headerOf = (name: string): string | undefined => root?.headers?.[name]

  const plain = root ? findPart(root, (p) => p.mimeType === 'text/plain') : null
  const html = root ? findPart(root, (p) => p.mimeType === 'text/html') : null

  const parts: ParsedMessage['parts'] = []

  const plainText = plain ? decodeText(plain) : null
  if (plainText !== null && plainText !== '') {
    parts.push({ contentType: 'text/plain', text: plainText })
  }

  const htmlText = html ? decodeText(html) : null
  if (htmlText !== null && htmlText !== '') {
    parts.push({ contentType: 'text/html', text: htmlText })
  }

  // Gmail's own internalDate is more reliable than the Date header when the
  // latter is missing or malformed.
  const dateMs = message.internalDate ? Number(message.internalDate) : NaN
  const headerDate = headerOf('date')
  const date = Number.isNaN(dateMs)
    ? headerDate
      ? new Date(headerDate)
      : undefined
    : new Date(dateMs)

  const references = headerOf('references')
  const messageIdHeader = headerOf('message-id')

  const displayFrom = headerOf('from') ?? ''
  const angle = displayFrom.match(/^(.*?)\s*<([^>]+)>$/)
  const fromName = angle?.[1].replace(/^"|"$/g, '').trim() || undefined

  return {
    subject: headerOf('subject') ?? '',
    from: extractAddress(displayFrom),
    fromName,
    to: addressesFrom(headerOf('to')),
    cc: addressesFrom(headerOf('cc')),
    date: date && !Number.isNaN(date.getTime()) ? date : undefined,
    messageId: messageIdHeader ? stripAngleBrackets(messageIdHeader) : message.id,
    inReplyTo: headerOf('in-reply-to')
      ? stripAngleBrackets(headerOf('in-reply-to') as string)
      : undefined,
    references: references
      ? references.split(/\s+/).filter(Boolean).map(stripAngleBrackets)
      : undefined,
    parts,
  }
}

/** Attachment metadata for a message, without downloading anything. */
export function toAttachmentRefs(message: GmailMessage): GmailAttachmentRef[] {
  return message.payload ? collectAttachments(message.payload) : []
}

/**
 * True when a message is a draft.
 *
 * Drafts are excluded from the inbox: they are the user's own unsent text, not
 * something anyone else wrote.
 */
export function isDraft(message: GmailMessage): boolean {
  return message.labelIds.includes('DRAFT')
}

/** True when a message lives in the trash. */
export function isTrashed(message: GmailMessage): boolean {
  return message.labelIds.includes('TRASHED')
}