/**
 * Build the mailbox client an account's provider calls for.
 *
 * The only place that maps an account row to an adapter. Everything downstream —
 * sync, send, attachment download, the conversation view — takes the neutral
 * client and never asks which service is behind it.
 */

import {
  getAccount,
  getAccountEnvelope,
  saveRefreshTokenEnvelope,
} from '#/lib/auth/accounts.ts'
import { createGmailClient } from '#/lib/auth/google.ts'
import { createGmailApiClient } from '#/lib/gmail/client.ts'
import { createMicrosoftMailbox } from '#/lib/microsoft/index.ts'

import type { MailboxClient, Provider } from './types.ts'

/** The provider's name in a sentence the user reads. */
export const PROVIDER_LABEL: Record<Provider, string> = {
  google: 'Google',
  microsoft: 'Outlook',
}

/**
 * Null when the account is gone or its token cannot be decrypted.
 *
 * Not an error: every caller treats "no client" as "this mailbox needs
 * reconnecting", which is a state the UI already has a control for.
 */
export async function createMailboxClientFor(
  accountId: string,
): Promise<MailboxClient | null> {
  const account = await getAccount(accountId)
  if (!account) return null

  const envelope = await getAccountEnvelope(accountId)
  if (!envelope) return null

  if (account.provider === 'microsoft') {
    return createMicrosoftMailbox({
      refreshTokenEnvelope: envelope,
      email: account.email,
      // Microsoft can rotate the refresh token on every refresh; losing the new
      // one signs the user out at some later sync, so it is written back here.
      onRefreshToken: (next) => saveRefreshTokenEnvelope(accountId, next),
    })
  }

  const gmail = await createGmailClient(envelope)
  return createGmailApiClient(gmail, accountId)
}
