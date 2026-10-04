/**
 * MIME parsing: raw RFC822 bytes -> ParsedMessage.
 *
 * Wraps postal-mime (dependency-free, runs anywhere) and normalises its output
 * into our own types so nothing else in the app depends on the parser choice.
 */

import PostalMime from 'postal-mime'

import type { MailPart, ParsedMessage } from './types.ts'

/**
 * Parse a raw RFC822 message.
 *
 * Gmail's `users.messages.get` with `format: 'raw'` returns base64url-encoded
 * bytes, which the Gmail adapter hands over as `raw`. Parsing is wrapped so a
 * single malformed message can't break a whole sync — we return what we have
 * rather than throwing.
 */
export async function parseRawMessage(raw: string): Promise<ParsedMessage> {
  let parsed

  try {
    parsed = await new PostalMime().parse(raw)
  } catch {
    // A message we cannot parse is still worth showing headers-only rather than
    // dropping it from the inbox entirely.
    return {
      subject: '',
      from: '',
      to: [],
      cc: [],
      parts: [],
    }
  }

  const parts: MailPart[] = []

  // postal-mime exposes html/text as single strings, not arrays.
  if (parsed.text) parts.push({ contentType: 'text/plain', text: parsed.text })
  if (parsed.html) parts.push({ contentType: 'text/html', text: parsed.html })

  for (const a of parsed.attachments) {
    parts.push({
      contentType: a.mimeType,
      filename: a.filename ?? undefined,
      contentId: a.contentId,
      disposition: a.disposition === 'inline' ? 'inline' : 'attachment',
      // postal-mime returns the payload already decoded, as a string.
      data: a.content,
    })
  }

  return {
    subject: parsed.subject ?? '',
    from: parsed.from?.address ?? '',
    fromName: parsed.from?.name ?? undefined,
    to: (parsed.to ?? [])
      .map((a) => a.address)
      .filter((a): a is string => Boolean(a)),
    cc: (parsed.cc ?? [])
      .map((a) => a.address)
      .filter((a): a is string => Boolean(a)),
    // postal-mime returns an ISO string, or the raw header if unparseable.
    date: parsed.date ? new Date(parsed.date) : undefined,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references
      ? parsed.references.split(/\s+/).filter(Boolean)
      : undefined,
    parts,
  }
}

/**
 * Pick the best body part.
 *
 * Preference order matters for chat rendering: text/plain is already
 * quote-marked and easier to strip reliably, so it wins when present. HTML is
 * only the fallback (and is kept separately for rich rendering).
 */
export function selectBodyPart(message: ParsedMessage): {
  text: string | null
  html: string | null
} {
  const plain = message.parts.find((p) => p.contentType === 'text/plain')
  const html = message.parts.find((p) => p.contentType === 'text/html')

  return {
    text: plain?.text ?? null,
    html: html?.text ?? null,
  }
}

/** Everything that isn't body text — attachments and inline images. */
export function selectAttachments(message: ParsedMessage): MailPart[] {
  return message.parts.filter(
    (p) => p.contentType !== 'text/plain' && p.contentType !== 'text/html',
  )
}

/** True when the body has an inline image, which the UI previews. */
export function hasInlineImage(attachments: MailPart[]): boolean {
  return attachments.some(
    (a) =>
      a.disposition === 'inline' &&
      typeof a.contentType === 'string' &&
      a.contentType.startsWith('image/'),
  )
}
