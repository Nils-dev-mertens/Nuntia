/**
 * Types for the mail parsing layer.
 *
 * Everything here is pure data — no Gmail types leak in. The Gmail adapter
 * converts a `users.messages.get` response into `ParsedMessage`.
 */

/** A single MIME part, already decoded from base64/quoted-printable. */
export type MailPart = {
  contentType: string
  /** filename from Content-Disposition, when present */
  filename?: string
  /** decoded content as text; binary parts are left undefined */
  text?: string
  /**
   * Decoded attachment payload. postal-mime returns a string for text-ish
   * parts and an ArrayBuffer/Uint8Array for binary, so this is widened — the
   * Gmail adapter re-fetches binary parts on demand anyway.
   */
  data?: string | ArrayBuffer | Uint8Array
  contentId?: string
  disposition?: 'inline' | 'attachment'
}

/** An email after MIME decoding but before any stripping. */
export type ParsedMessage = {
  subject: string
  from: string
  /** Optional display name from the From header. */
  fromName?: string
  to: string[]
  cc: string[]
  date?: Date
  messageId?: string
  inReplyTo?: string
  references?: string[]
  parts: MailPart[]
}

/**
 * The result of stripping an email down to what the user actually wrote.
 *
 * `body` is what Nuntia renders as a chat bubble. `greeting`, `signature` and
 * `quote` are retained so the send path can put them back — the user never sees
 * them, but recipients still receive a normal-looking email.
 */
export type CleanedMessage = {
  /** The user's actual content, with greeting/signature/quotes removed. */
  body: string
  /** Detected greeting, e.g. "Hi Sarah,". Preserved verbatim. */
  greeting: string | null
  /** Detected signature block. Preserved verbatim. */
  signature: string | null
  /** The stripped quoted history, kept for context/debugging. */
  quote: string | null
  /** Parts that were attachments or inline images, not body text. */
  attachments: MailPart[]
  /** True when we stripped something, so the UI can offer "show original". */
  wasStripped: boolean
}

/** Options controlling how aggressive stripping is. */
export type StripOptions = {
  /**
   * Strip greetings. Off by default for machine-generated mail where a leading
   * "Hi," is more likely part of the content.
   */
  stripGreeting?: boolean
  /**
   * Strip signatures. Off by default — some senders sign with meaningful
   * content, and the user's own signature is restored on send anyway.
   */
  stripSignature?: boolean
}
