/**
 * Google OAuth 2.0.
 *
 * Authorization-code flow with PKCE. Tokens are long-lived credentials, so the
 * refresh token is encrypted before it ever touches the database, and the
 * session cookie holds nothing but an account id.
 */

import { google } from 'googleapis'
import { CodeChallengeMethod } from 'google-auth-library'

import { appUrlFor } from '#/lib/app-url.ts'

import { encrypt, tryDecrypt } from './crypto.ts'
import { codeChallenge, stashOAuthRoundTrip } from './oauth.ts'

export { readState, readVerifier } from './oauth.ts'

/**
 * Scopes for the MVP.
 *
 * Deliberately minimal: `gmail.readonly` plus `send` is enough to read threads
 * and reply. No modify/delete scope, so a bug cannot destroy mail.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
]

function clientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID
  if (!id) throw new Error('GOOGLE_CLIENT_ID is not set')
  return id
}

function clientSecret(): string {
  const secret = process.env.GOOGLE_CLIENT_SECRET
  if (!secret) throw new Error('GOOGLE_CLIENT_SECRET is not set')
  return secret
}

/**
 * Where Google sends the browser back.
 *
 * `LUMEN_APP_URL` is the base, so a deployment configures its origin once and
 * both providers follow it. A hard-coded `localhost` default here meant every
 * deployed install came back to the visitor's own machine after consent unless
 * it also set a second, provider-specific variable. `GOOGLE_REDIRECT_URI` still
 * wins when set, for a callback on a different host — a `GOOGLE_REDIRECT_URI` in
 * `.env` that is present but empty is treated as unset.
 */
export function redirectUri(): string {
  return (
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    appUrlFor('/auth/google/callback')
  )
}

/**
 * Create an OAuth2 client with no fixed credentials.
 *
 * Used for the code-exchange step, where we pass `code` directly rather than
 * setting credentials that would auto-refresh.
 */
function createClient() {
  return new google.auth.OAuth2(clientId(), clientSecret(), redirectUri())
}

/**
 * Build the Google consent URL.
 *
 * Returns the URL plus the `state` and PKCE `verifier` that the caller must
 * stash in short-lived cookies and verify on the way back. `state` blocks CSRF;
 * PKCE stops an intercepted auth code from being redeemed without our secret.
 */
export async function buildAuthUrl(
  setCookie: (
    name: string,
    value: string,
    opts: Record<string, unknown>,
  ) => void,
): Promise<string> {
  const { state, verifier } = stashOAuthRoundTrip(setCookie)

  return createClient().generateAuthUrl({
    access_type: 'offline', // ask for a refresh token
    // Force a refresh token even when one already exists for this app, and
    // force Google's account chooser so a second mailbox can actually be
    // picked — `consent` alone re-authorizes whichever Google account the
    // browser is already signed into, which makes "add account" impossible.
    prompt: 'consent select_account',
    scope: SCOPES,
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: CodeChallengeMethod.S256,
    include_granted_scopes: true,
  })
}

export type TokenResult = {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
  scopes: string
}

/**
 * Exchange the auth code for tokens.
 *
 * The refresh token comes back encrypted and ready to persist. It is null when
 * Google reuses an existing grant — in that case we keep the stored one.
 */
export async function exchangeCode(
  code: string,
  verifier: string,
): Promise<TokenResult> {
  const client = createClient()

  const { tokens } = await client.getToken({
    code,
    codeVerifier: verifier,
    redirect_uri: redirectUri(),
  })

  return {
    accessToken: tokens.access_token ?? '',
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    scopes: tokens.scope ?? SCOPES.join(' '),
  }
}

/**
 * Encrypt a refresh token for storage.
 *
 * Google omits the refresh token when the user has already granted access, so
 * this is a no-op for null rather than an error.
 */
export function encryptRefreshToken(
  refreshToken: string | null,
): string | null {
  return refreshToken ? encrypt(refreshToken) : null
}

/** Recover a refresh token from storage. */
export function decryptRefreshToken(envelope: string): string | null {
  return tryDecrypt(envelope)
}

/** Fetch the authenticated user's profile, used to identify the account. */
export async function fetchProfile(accessToken: string): Promise<{
  email: string
  name: string | null
}> {
  const oauth2 = createClient()
  oauth2.setCredentials({ access_token: accessToken })

  const oauth2Client = google.oauth2({ version: 'v2', auth: oauth2 })
  const { data } = await oauth2Client.userinfo.get()

  if (!data.email) {
    throw new Error('Google did not return an email address for this account')
  }

  return { email: data.email.toLowerCase(), name: data.name ?? null }
}

/**
 * An authenticated Gmail client for an account.
 *
 * The refresh token is decrypted in memory only; it is never written to disk
 * or logged.
 */
export async function createGmailClient(
  refreshTokenEnvelope: string,
): Promise<ReturnType<typeof google.gmail>> {
  // Wrapped in a promise for call-site consistency with the rest of the auth
  // layer, which is async throughout.
  const refreshToken = decryptRefreshToken(refreshTokenEnvelope)

  if (!refreshToken) {
    throw new Error('Stored refresh token could not be decrypted')
  }

  const auth = createClient()
  auth.setCredentials({ refresh_token: refreshToken })

  return google.gmail({ version: 'v1', auth })
}
