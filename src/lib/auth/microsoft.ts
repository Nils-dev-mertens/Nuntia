/**
 * Microsoft identity platform (Outlook.com / Microsoft 365).
 *
 * The same authorization-code + PKCE flow as Google, against the v2.0 endpoint.
 * The tenant segment is configurable so an install can be pinned to one work
 * tenant; the default `common` accepts both work/school and personal accounts,
 * which is what "add Outlook" should mean for a single-user app.
 *
 * Tokens are stored the same way: encrypted at rest, never in the session
 * cookie. Graph access tokens are fetched from the stored refresh token on
 * demand and cached by the client that uses them.
 */

import { tryDecrypt } from './crypto.ts'
import { codeChallenge, stashOAuthRoundTrip } from './oauth.ts'

export { readState, readVerifier } from './oauth.ts'

/** What the app asks for. Read and send only — no delete or modify scope. */
export const MICROSOFT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
]

/** Graph REST base. Injectable through `createGraphClient` for tests. */
export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0'

function clientId(): string {
  const id = process.env.MICROSOFT_CLIENT_ID
  if (!id) throw new Error('MICROSOFT_CLIENT_ID is not set')
  return id
}

function clientSecret(): string {
  const secret = process.env.MICROSOFT_CLIENT_SECRET
  if (!secret) throw new Error('MICROSOFT_CLIENT_SECRET is not set')
  return secret
}

/** `common`, `organizations`, `consumers`, or a tenant id. */
export function tenant(): string {
  return process.env.MICROSOFT_TENANT ?? 'common'
}

export function redirectUri(): string {
  return (
    process.env.MICROSOFT_REDIRECT_URI ??
    'http://localhost:3000/auth/microsoft/callback'
  )
}

function authorizeEndpoint(): string {
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`
}

function tokenEndpoint(): string {
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`
}

/**
 * Build the Microsoft consent URL.
 *
 * `prompt=select_account` is the equivalent of Google's account chooser: without
 * it a second mailbox re-authorizes whichever account the browser already holds,
 * and "add account" is impossible. Microsoft returns a refresh token on the
 * first consent for the requested `offline_access` scope, so no `consent` force
 * is needed here.
 */
export async function buildAuthUrl(
  setCookie: (
    name: string,
    value: string,
    opts: Record<string, unknown>,
  ) => void,
): Promise<string> {
  const { state, verifier } = stashOAuthRoundTrip(setCookie)

  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  })

  return `${authorizeEndpoint()}?${params.toString()}`
}

export type MicrosoftTokenResult = {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
  scopes: string
}

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

/** POST the token endpoint and turn an OAuth error into a readable one. */
async function requestToken(
  body: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<MicrosoftTokenResult> {
  const response = await fetchImpl(tokenEndpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      ...body,
    }).toString(),
  })

  const payload = (await response.json()) as TokenResponse

  if (!response.ok || payload.error || !payload.access_token) {
    const detail = payload.error_description ?? payload.error ?? 'unknown error'
    throw new Error(`Microsoft sign-in failed: ${detail}`)
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt:
      typeof payload.expires_in === 'number'
        ? new Date(Date.now() + payload.expires_in * 1000)
        : null,
    scopes: payload.scope ?? MICROSOFT_SCOPES.join(' '),
  }
}

/** Redeem an authorization code. */
export function exchangeCode(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MicrosoftTokenResult> {
  return requestToken(
    {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri(),
      scope: MICROSOFT_SCOPES.join(' '),
    },
    fetchImpl,
  )
}

/**
 * A fresh Graph access token from the stored refresh token.
 *
 * Microsoft rotates refresh tokens: the response may carry a new one, and the
 * old one can eventually stop working. The caller gets the new value back so it
 * can be re-encrypted and saved, exactly like Google's `upsertAccount` does when
 * a first sign-in happens to return one.
 */
export function refreshAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MicrosoftTokenResult> {
  return requestToken(
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: MICROSOFT_SCOPES.join(' '),
    },
    fetchImpl,
  )
}

/**
 * Recover the plaintext refresh token from the stored envelope.
 *
 * The envelope is the same AES-256-GCM ciphertext Google accounts use; the
 * provider is a property of the account row, not of the encryption.
 */
export function decryptStoredToken(envelope: string): string | null {
  return tryDecrypt(envelope)
}

/** Fetch the authenticated user's profile, used to identify the account. */
export async function fetchProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ email: string; name: string | null }> {
  const response = await fetchImpl(
    `${GRAPH_BASE_URL}/me?$select=mail,userPrincipalName,displayName`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  )

  if (!response.ok) {
    throw new Error(
      `Microsoft profile request failed (${response.status}). Check that the app has User.Read.`,
    )
  }

  const data = (await response.json()) as {
    mail?: string | null
    userPrincipalName?: string | null
    displayName?: string | null
  }

  // Personal accounts often have no `mail`; the UPN is the address then.
  const email = data.mail ?? data.userPrincipalName
  if (!email) {
    throw new Error(
      'Microsoft did not return an email address for this account',
    )
  }

  return { email: email.toLowerCase(), name: data.displayName ?? null }
}
