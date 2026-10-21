/**
 * Outlook / Microsoft 365, behind the mailbox seam.
 *
 * `client.ts` talks Graph; `message.ts` converts Graph's JSON into the neutral
 * MIME-shaped message. This module owns the one thing above those: turning the
 * stored refresh token into a client with a working access token, and keeping
 * that token fresh without asking the caller.
 */

import { encrypt } from '#/lib/auth/crypto.ts'
import { decryptStoredToken, refreshAccessToken } from '#/lib/auth/microsoft.ts'
import type { MailboxClient } from '#/lib/mailbox/types.ts'

import { createGraphClient, GRAPH_BASE_URL } from './client.ts'

export {
  createGraphClient,
  GRAPH_BASE_URL,
  GRAPH_MAX_ATTACHMENT_BYTES,
  MailboxCursorExpiredError,
  MicrosoftAuthError,
  MicrosoftRateLimitError,
} from './client.ts'
export type { GraphClientOptions } from './client.ts'
export { toProviderMessage } from './message.ts'
export type {
  GraphAttachment,
  GraphMessage,
  GraphRecipient,
} from './message.ts'

export type MicrosoftMailboxOptions = {
  /** The stored AES-256-GCM envelope. Decrypted here, in memory only. */
  refreshTokenEnvelope: string
  email: string
  fetchImpl?: typeof fetch
  baseUrl?: string
  /**
   * Called with a new encrypted refresh token when Microsoft rotates one.
   *
   * Microsoft can invalidate the old refresh token after a rotation, so losing
   * the new one signs the user out at some unpredictable later sync. The caller
   * persists it; failing to do so is not fatal for this run.
   */
  onRefreshToken?: (envelope: string) => Promise<void>
}

type CachedToken = {
  accessToken: string
  /** Epoch milliseconds. */
  expiresAt: number
}

/**
 * Build a Graph-backed mailbox client.
 *
 * The access token is cached per client, which is one sync or one send. Both are
 * short-lived, so there is no need for a shared cache — and not sharing one keeps
 * a rotated token from leaking into another account's client.
 */
export function createMicrosoftMailbox(
  opts: MicrosoftMailboxOptions,
): MailboxClient {
  const refreshToken = decryptStoredToken(opts.refreshTokenEnvelope)

  if (!refreshToken) {
    throw new Error('Stored Microsoft refresh token could not be decrypted')
  }

  let token: CachedToken | null = null

  const getAccessToken = async (): Promise<string> => {
    // A minute of slack: a token that expires during a paged backfill would
    // otherwise fail halfway through it.
    if (token && token.expiresAt - Date.now() > 60_000) {
      return token.accessToken
    }

    const result = await refreshAccessToken(refreshToken, opts.fetchImpl)

    token = {
      accessToken: result.accessToken,
      expiresAt: result.expiresAt?.getTime() ?? Date.now() + 50 * 60_000,
    }

    if (result.refreshToken && result.refreshToken !== refreshToken) {
      try {
        await opts.onRefreshToken?.(encrypt(result.refreshToken))
      } catch (error) {
        console.error(
          '[microsoft] could not store the rotated refresh token:',
          error,
        )
      }
    }

    return token.accessToken
  }

  return createGraphClient({
    getAccessToken,
    email: opts.email,
    fetchImpl: opts.fetchImpl,
    baseUrl: opts.baseUrl ?? GRAPH_BASE_URL,
  })
}
