/**
 * The approval email.
 *
 * It goes out through the operator's *own* connected mailbox rather than an
 * email service. That is a product decision as much as a simplification: the
 * invitation arrives from a real address, a reply lands in the inbox Nuntia is
 * about, and there is no second bill, no sending domain to verify and no new
 * secret to rotate. `sendNewMessage` already does the provider work (Gmail raw
 * MIME, Graph `sendMail`), the operator's greeting and signature, and the
 * contact book.
 *
 * What it costs is one dependency: the operator needs a mailbox connected. When
 * there is none, the invite is still issued — the approval is a decision about a
 * person, and the mail is a delivery detail — and `/admin` offers the link to
 * copy instead. `/admin` says which of the two happened.
 */

import { listAccounts } from '#/lib/auth/accounts.ts'
import { sendNewMessage } from '#/lib/mailbox/send-new.ts'

import { formatCode } from './codes.ts'
import { markInviteNotified, markInviteNotifyFailed } from './repository.ts'

export type NotifyResult = {
  sent: boolean
  /** Why it was not sent, when it was not. Shown to the operator. */
  reason: string | null
}

/** The origin invitations point at. */
export function appUrl(): string {
  const configured = process.env.LUMEN_APP_URL?.trim()
  // A link built from `request.url` is the internal origin behind the reverse
  // proxy that will host this, which is the one thing a copied link cannot fix.
  return (configured || 'http://localhost:3000').replace(/\/+$/, '')
}

export function inviteLink(code: string): string {
  return `${appUrl()}/join/${formatCode(code)}`
}

/**
 * Which mailbox the invitation comes from.
 *
 * `LUMEN_INVITE_SENDER` names it outright; otherwise the operator's first
 * connected mailbox. A named address that is not connected falls through to the
 * first mailbox rather than failing — a typo in an env var should not stop the
 * beta.
 */
async function senderAccount(operatorId: string) {
  const accounts = await listAccounts(operatorId)
  if (accounts.length === 0) return null

  const preferred = process.env.LUMEN_INVITE_SENDER?.trim().toLowerCase()
  if (preferred) {
    const match = accounts.find(
      (account) => account.email.toLowerCase() === preferred,
    )
    if (match) return match
  }

  return accounts[0] ?? null
}

const NO_MAILBOX_REASON =
  'No mailbox is connected to your account, so the invite was not emailed.'

export async function notifyInvite(input: {
  inviteId: string
  code: string
  to: string
  operatorId: string
}): Promise<NotifyResult> {
  const account = await senderAccount(input.operatorId)

  if (!account) {
    await markInviteNotifyFailed(input.inviteId, NO_MAILBOX_REASON)
    return { sent: false, reason: NO_MAILBOX_REASON }
  }

  const body = [
    'You asked for access to Nuntia. It is ready:',
    '',
    inviteLink(input.code),
    '',
    'The link works for 14 days. It asks you to choose a password, and that is',
    'what you sign in with from then on — this email is not needed again.',
  ].join('\n')

  try {
    await sendNewMessage({
      userId: input.operatorId,
      accountId: account.id,
      to: [input.to],
      cc: [],
      bcc: [],
      subject: 'Your Nuntia invite',
      body,
      attachments: [],
    })

    await markInviteNotified(input.inviteId)
    return { sent: true, reason: null }
  } catch (error) {
    // The decision stands; the send is retryable from `/admin`.
    const reason =
      error instanceof Error ? error.message : 'Could not send the invite.'
    console.error('[invites] could not send the approval email:', error)
    await markInviteNotifyFailed(input.inviteId, reason)
    return { sent: false, reason }
  }
}

/** Resend for an invite whose first attempt failed. */
export async function resendInvite(input: {
  inviteId: string
  code: string
  to: string
  operatorId: string
}): Promise<NotifyResult> {
  return notifyInvite(input)
}
