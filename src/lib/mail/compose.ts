/**
 * The send side: rebuild a normal-looking email from what Lumen displays.
 *
 * This is the inverse of `strip.ts`. The user edits a bubble with no greeting
 * and no signature; the recipient receives something that reads like every
 * other email they've ever got.
 */

import type { ParsedMessage } from './types.ts'

export type ComposeInput = {
  /** The user's text, as shown in the chat bubble. No greeting/signature. */
  body: string
  /** Greeting to restore, e.g. "Hi Sarah,". */
  greeting?: string | null
  /** Signature to restore. */
  signature?: string | null
  /** Whether to quote the thread being replied to. */
  quoteOriginal?: boolean
  /** The thread being replied to, if quoting. Supplies headers and plain text. */
  original?: ParsedMessage | null
  /**
   * The original message's HTML body, for the rich alternative part.
   *
   * Separate from `original.parts` because the part stored on the conversation
   * is the *stripped* body: no quote, no greeting, no signature. Quoting the
   * stripped text back at the sender is what produced walls of `>` lines, so the
   * HTML alternative quotes this instead.
   */
  originalHtml?: string | null
}

/**
 * A composed reply, in both forms.
 *
 * `html` is null when there is nothing rich to say — a reply whose only content
 * is the user's text and a signature — in which case the caller sends plain
 * text alone rather than an empty HTML part.
 */
export type ComposedReply = {
  text: string
  html: string | null
}

/** Binary file included in an outgoing message. */
export type MimeAttachment = {
  filename: string
  contentType: string
  data: Uint8Array
}

/** Build the attribution line that introduces quoted history. */
function attributionLine(original: ParsedMessage): string {
  const date = original.date
    ? original.date.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'an earlier time'

  return `On ${date} ${original.from} wrote:`
}

/**
 * Assemble the full text body for an outgoing reply.
 *
 * Parts, in order: greeting, body, signature, quoted thread. The signature is
 * part of the reply, so it comes before the quoted history rather than after it.
 *
 * Returns both representations: the plain text one is always produced, and the
 * HTML one when the reply quotes something that had an HTML body. Every mail
 * client that can show HTML shows that; the rest fall back to the text part.
 */
export function composeReply(input: ComposeInput): ComposedReply {
  return {
    text: composeText(input),
    html: composeHtml(input),
  }
}

/**
 * Plain-text representation: greeting, body, signature, quoted history.
 *
 * The signature belongs to the user's own message, so it sits directly under
 * the text. Putting it *below* the quote was wrong twice over: it read as if it
 * belonged to the quoted message, and re-parsing the sent mail found no
 * signature at all — `stripSignature` only looks above the quote — so the next
 * reply silently lost it.
 */
function composeText(input: ComposeInput): string {
  const sections: string[] = []

  const greeting = input.greeting?.trim()
  const body = input.body.trim()

  if (greeting && body) {
    sections.push(`${greeting}\n\n${body}`)
  } else if (greeting) {
    sections.push(greeting)
  } else {
    sections.push(body)
  }

  const signature = input.signature?.trim()
  if (signature) sections.push(signature)

  if (input.quoteOriginal && input.original) {
    const quoted = [
      attributionLine(input.original),
      ...originalPlainText(input.original),
    ]
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n')

    if (quoted.trim()) {
      sections.push(quoted)
    }
  }

  return sections.filter(Boolean).join('\n\n')
}

/**
 * Lines of the original's plain-text part, ready to be `>`-prefixed.
 *
 * Falls back to the original's subject and author when it carried no plain text
 * at all, so the attribution still names someone. Quoting nothing at all would
 * leave the recipient with an unattributed reply.
 */
function originalPlainText(original: ParsedMessage): string[] {
  const text = original.parts
    .filter((p) => p.contentType === 'text/plain' && p.text)
    .map((p) => (p.text as string).trim())
    .filter(Boolean)

  if (text.length > 0) return text.flatMap((t) => t.split('\n'))

  return [`(${original.subject})`]
}

/**
 * HTML representation.
 *
 * The quoted original goes inside a `<blockquote>`, which is how mail clients
 * mark quoted history in HTML and what makes the reply look like a reply rather
 * than a wall of `>` lines. Null when there is no HTML to quote.
 */
function composeHtml(input: ComposeInput): string | null {
  const originalHtml = input.originalHtml?.trim()
  if (!input.quoteOriginal || !originalHtml || !input.original) return null

  const greeting = input.greeting?.trim()
  const body = input.body.trim()
  const signature = input.signature?.trim()

  const sections: string[] = ['<div>']
  if (greeting) sections.push(`<p>${escapeHtml(greeting)}</p>`)
  if (body) sections.push(`<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>`)

  // Signature before the quote, matching the plain-text part: it belongs to the
  // reply, not to the message being quoted.
  if (signature)
    sections.push(`<p>${escapeHtml(signature).replace(/\n/g, '<br>')}</p>`)

  sections.push(
    `<blockquote>${escapeHtml(attributionLine(input.original))}${originalHtml}</blockquote>`,
  )

  sections.push('</div>')

  return sections.join('')
}

/**
 * Escape text for interpolation into HTML.
 *
 * The user's own words and the original's HTML are the only two things placed
 * into the reply's HTML part, and the original is already sanitised upstream, so
 * this only has to cover the plain-text values.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Build the RFC 5322 message we'd hand to `users.messages.send`.
 *
 * With only `body`, the message is `text/plain`. With `html` as well it becomes
 * `multipart/alternative` with plain first and HTML second — the ordering is
 * required by RFC 2046: clients pick the *last* part they understand, so the
 * rich one goes last or it is ignored.
 *
 * Headers are minimal and correct; Gmail fills in Message-ID, Date and the
 * thread linkage from In-Reply-To / References.
 */
export function buildMimeMessage(args: {
  to: string[]
  subject: string
  body: string
  /** Rich alternative. Omit for a plain-text-only message. */
  html?: string | null
  from?: string
  cc?: string[]
  threadId?: string
  inReplyTo?: string
  references?: string[]
  attachments?: MimeAttachment[]
}): { raw: string; threadId?: string } {
  const {
    to,
    subject,
    body,
    html,
    from,
    cc,
    threadId,
    inReplyTo,
    references,
    attachments = [],
  } = args

  const headers: string[] = []
  if (from) headers.push(`From: ${from}`)
  headers.push(`To: ${to.join(', ')}`)
  if (cc?.length) headers.push(`Cc: ${cc.join(', ')}`)
  // Subjects carry emoji and accents ("Re: 🖤 LAATSTE KANS"), so they have to be
  // RFC 2047 encoded — a raw UTF-8 header is not legal and clients mangle it.
  headers.push(`Subject: ${encodeHeaderValue(subject)}`)
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`)
  if (references?.length) headers.push(`References: ${references.join(' ')}`)
  headers.push('MIME-Version: 1.0')

  const raw =
    attachments.length > 0
      ? multipartMixed(headers, body, html ?? null, attachments)
      : html
        ? multipartAlternative(headers, body, html)
        : singlePart(headers, body)

  return { raw, threadId }
}

/** `text/plain` body with a quoted-printable body part. */
function singlePart(headers: string[], body: string): string {
  return [
    ...headers,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    encodeQuotedPrintable(body),
  ].join('\r\n')
}

/**
 * `multipart/alternative` carrying both representations.
 *
 * The boundary is derived from the content rather than randomised, so composing
 * the same reply twice produces byte-identical output — which is what makes the
 * send path testable at all.
 */
function multipartAlternative(
  headers: string[],
  body: string,
  html: string,
): string {
  const boundary = `----=_Lumen_${shortHash(`${body}\u0000${html}`)}`

  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    encodeQuotedPrintable(body),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    encodeQuotedPrintable(html),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

/**
 * `multipart/mixed` with a text body (or nested alternatives) and file parts.
 */
function multipartMixed(
  headers: string[],
  body: string,
  html: string | null,
  attachments: MimeAttachment[],
): string {
  const contentKey = [
    body,
    html ?? '',
    ...attachments.flatMap((a) => [
      a.filename,
      a.contentType,
      hashBytes(a.data),
    ]),
  ].join('\u0000')
  const boundary = `----=_Lumen_Mixed_${shortHash(contentKey)}`
  const textPart = html
    ? multipartAlternative([], body, html)
    : singlePart([], body)
  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    textPart,
  ]

  for (const attachment of attachments) {
    const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(
      attachment.contentType,
    )
      ? attachment.contentType
      : 'application/octet-stream'
    const encodedFilename = encodeURIComponent(attachment.filename).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    const fallbackFilename =
      attachment.filename.replace(/[^\x20-\x7e]/g, '_').replace(/[";]/g, '_') ||
      'attachment'

    parts.push(
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${fallbackFilename}"`,
      `Content-Disposition: attachment; filename="${fallbackFilename}"; filename*=UTF-8''${encodedFilename}`,
      'Content-Transfer-Encoding: base64',
      '',
      encodeBase64Lines(attachment.data),
    )
  }

  parts.push(`--${boundary}--`, '')
  return parts.join('\r\n')
}

/** Encode binary bytes as MIME base64, wrapped to 76 columns. */
function encodeBase64Lines(bytes: Uint8Array): string {
  const encoded = base64Bytes(bytes)
  return encoded.match(/.{1,76}/g)?.join('\r\n') ?? ''
}

/** Stable compact digest for binary attachment content. */
function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Base64-encode bytes without converting binary data to UTF-8. */
function base64Bytes(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + chunkSize, bytes.length),
    )
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

/**
 * Encode a header value that is not plain ASCII.
 *
 * RFC 2047 encoded-words, base64. ASCII-only values pass through untouched so
 * ordinary subjects stay readable in raw form, which matters when debugging a
 * send by reading the bytes Gmail accepted.
 */
export function encodeHeaderValue(value: string): string {
  if (!/[^\x20-\x7e]/.test(value)) return value

  return `=?UTF-8?B?${base64(value)}?=`
}

/** Base64 with the standard alphabet, no line wrapping. */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary)
}

/** Short, stable digest used only to make MIME boundaries collision-unlikely. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5

  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    // Multiplicative step, kept in 32-bit range without BigInt.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(16).padStart(8, '0')
}

/**
 * QP-encode a body. Gmail requires this for non-ASCII.
 *
 * Non-ASCII is encoded per UTF-8 *byte*, not per code point: an em dash (U+2014)
 * must become =E2=80=94, not =2014. Encoding the code point directly produces a
 * sequence a decoder reads as =20 ("space") followed by literal "14".
 */
export function encodeQuotedPrintable(input: string): string {
  const lines: string[] = []
  let current = ''

  const pushLine = () => {
    lines.push(current)
    current = ''
  }

  for (const ch of input) {
    if (ch === '\n') {
      pushLine()
      continue
    }

    const code = ch.codePointAt(0) ?? 0

    // Printable ASCII (except '=' and CR) passes through verbatim.
    if (code === 13) continue

    if (code >= 32 && code <= 126 && code !== 61) {
      current += ch
      continue
    }

    // Everything else becomes one =XX per UTF-8 byte.
    for (const byte of new TextEncoder().encode(ch)) {
      const encoded = '=' + byte.toString(16).toUpperCase().padStart(2, '0')

      // Respect the 76-column limit with a soft line break.
      if (current.length + encoded.length > 75) {
        lines.push(current + '=')
        current = ''
      }
      current += encoded
    }
  }

  lines.push(current)

  return lines.map((l, i) => (i === lines.length - 1 ? l : l + '\r\n')).join('')
}
