/**
 * Sending a brand-new message.
 *
 * The user types only the message. The greeting and signature are restored the
 * same way a reply restores them, from the same profile the reply path reads: a
 * sender the user has tuned gets their pair, otherwise the account-wide default,
 * otherwise how the user signed their own most recent sent mail. There is no
 * thread to quote, so the only difference from a reply is the missing quote —
 * not the missing salutation.
 *
 * What is shared with the reply path is everything that protects the send: the
 * ownership check, the recipient validation and the attachment limits.
 *
 * One consequence of the provider seam: Gmail returns the new thread id and the
 * message is pulled straight back into the database, so the composer can open
 * it. Graph's `sendMail` answers 202 with no identifier, so that send lands on
 * the inbox and appears on the next sync.
 */

import { assertOwnedAccount } from '#/lib/auth/accounts.ts'
import { recordContactedAddresses } from '#/lib/contacts/index.ts'
import {
  getLastOwnMessageStyle,
  getParsingProfileContext,
  resolveReplyStyle,
} from '#/lib/conversation/index.ts'
import type { ReplyStyle } from '#/lib/conversation/index.ts'
import { composeNewMessage } from '#/lib/mail/index.ts'

import { decodeAttachmentUploads } from './attachment-uploads.ts'
import type { AttachmentUpload } from './attachment-uploads.ts'
import { createMailboxClientFor } from './provider.ts'

/** Raised when a new message cannot be sent; the sentence is shown verbatim. */
export class NewMessageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NewMessageError'
  }
}

export type NewMessageInput = {
  userId: string
  /** The mailbox the message leaves from. */
  accountId: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  attachments?: AttachmentUpload[]
}

export type NewMessageResult = {
  /** The provider thread the message created, when it reports one. */
  threadId: string | null
  /** The mailbox it left from, for a follow-up load. */
  accountId: string
}

const MAX_RECIPIENTS = 50
const MAX_SUBJECT_LENGTH = 300
const MAX_BODY_LENGTH = 500_000

/** Deliberately loose; the provider is the real authority on what it accepts. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Normalise one address list, refusing junk and duplicates.
 *
 * Case is folded for the duplicate check only: `Alice@` and `alice@` are the
 * same recipient, but the address is sent as the user typed it.
 */
function parseAddresses(
  values: string[],
  label: 'To' | 'Cc' | 'Bcc',
): string[] {
  if (!Array.isArray(values)) {
    throw new NewMessageError(`${label} must be a list of addresses.`)
  }
  if (values.length > MAX_RECIPIENTS) {
    throw new NewMessageError(
      `Add no more than ${MAX_RECIPIENTS} addresses to ${label}.`,
    )
  }

  const seen = new Set<string>()
  const out: string[] = []

  for (const raw of values) {
    if (typeof raw !== 'string') {
      throw new NewMessageError(`${label} contains an invalid address.`)
    }
    const address = raw.trim()
    if (!address) continue
    if (address.length > 254 || !EMAIL_RE.test(address)) {
      throw new NewMessageError(`${address} is not a valid email address.`)
    }

    const key = address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(address)
  }

  return out
}

/**
 * The greeting and signature a message to this recipient goes out with.
 *
 * Same three sources, same order, same function as the reply path — a sender
 * with a style switched on wins, then the account default, then the user's own
 * last sent mail in this mailbox. Exported because the composer shows exactly
 * what will be added, and a preview computed differently from the send is a
 * preview that lies.
 */
export async function resolveNewMessageStyle(
  accountId: string,
  recipient: string | null,
): Promise<ReplyStyle> {
  const key = recipient?.trim().toLowerCase() ?? ''

  const [context, lastOwnerMessage] = await Promise.all([
    getParsingProfileContext(accountId),
    getLastOwnMessageStyle(accountId),
  ])

  return resolveReplyStyle({
    account: context.replyStyles.account,
    sender: key ? context.replyStyles.senders[key] : null,
    lastOwnerMessage,
  })
}

/**
 * Send one new message.
 *
 * `attachments` arrive as base64 from the composer and are decoded here, before
 * any provider sees them, so the limits are enforced in one place.
 */
export async function sendNewMessage(
  input: NewMessageInput,
  /**
   * How the mailbox client is built. Injectable so tests can drive the whole
   * send path — ownership check, validation, provider call — without a
   * credential in the environment.
   */
  deps: { clientFor?: typeof createMailboxClientFor } = {},
): Promise<NewMessageResult> {
  const clientFor = deps.clientFor ?? createMailboxClientFor
  const accountId = input.accountId.trim().toLowerCase()
  if (!accountId) throw new NewMessageError('Choose a mailbox to send from.')

  // Ownership before anything else: the account id comes from the browser.
  await assertOwnedAccount(input.userId, accountId)

  const to = parseAddresses(input.to, 'To')
  const cc = parseAddresses(input.cc, 'Cc')
  const bcc = parseAddresses(input.bcc, 'Bcc')

  if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
    throw new NewMessageError('Add at least one recipient.')
  }

  const subject = typeof input.subject === 'string' ? input.subject.trim() : ''
  if (!subject) throw new NewMessageError('Give the message a subject.')
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new NewMessageError(
      `Keep the subject to ${MAX_SUBJECT_LENGTH} characters or fewer.`,
    )
  }

  const body = typeof input.body === 'string' ? input.body : ''
  if (body.length > MAX_BODY_LENGTH) {
    throw new NewMessageError('That message is too long to send.')
  }

  const attachments = decodeAttachmentUploads(
    input.attachments ?? [],
    'message',
  )
  if (!body.trim() && attachments.length === 0) {
    throw new NewMessageError('Cannot send an empty message.')
  }

  const client = await clientFor(accountId)
  if (!client) {
    throw new NewMessageError(
      'This mailbox needs reconnecting before it can send mail.',
    )
  }
  if (!client.sendNewMessage) {
    throw new NewMessageError('This mailbox cannot send a new message.')
  }

  // The first To recipient decides the style, which is what "who is this going
  // to" means when there is more than one: the person the mail is addressed to.
  const style = await resolveNewMessageStyle(accountId, to[0] ?? null)
  const composed = composeNewMessage({
    body,
    greeting: style.greeting,
    signature: style.signature,
  })

  let result
  try {
    result = await client.sendNewMessage({
      subject,
      to,
      cc,
      bcc,
      text: composed.text,
      html: composed.html ?? '',
      attachments,
    })
  } catch (error) {
    // Provider errors are already sentences aimed at the user (a revoked grant,
    // an oversized attachment on Outlook). Anything else keeps its own text.
    throw new NewMessageError(
      error instanceof Error ? error.message : 'Could not send the message.',
    )
  }

  // The recipient list is the address book the next new message offers, so the
  // people just written to belong in it whether or not the sync below succeeds.
  // A failure here must not turn a delivered message into an error either.
  try {
    await recordContactedAddresses(accountId, [...to, ...cc, ...bcc])
  } catch (error) {
    console.warn('[send] the recipients could not be remembered:', error)
  }

  // Pull the new thread in so the composer can open it. A failure here must not
  // turn a delivered message into an error the user might resend.
  if (result.threadId) {
    try {
      const { refreshThread } = await import('#/lib/gmail/send.ts')
      await refreshThread(client, accountId, result.threadId)
    } catch (error) {
      console.warn('[send] the sent thread could not be stored:', error)
    }
  }

  return { threadId: result.threadId, accountId }
}
