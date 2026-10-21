/**
 * OAuth 2.0 authorization-code + PKCE, shared by the providers.
 *
 * Both Google and Microsoft are plain RFC 6749 authorization servers with S256
 * PKCE; only their endpoints and scopes differ. Keeping the cookie names, the
 * verifier generation and the challenge in one place means the two flows cannot
 * quietly drift apart — a state cookie written by one and read by the other is
 * the kind of bug that only appears on a slow redirect.
 */

const STATE_COOKIE = 'lumen_oauth_state'
const VERIFIER_COOKIE = 'lumen_oauth_verifier'
const OAUTH_COOKIE_TTL = 600 // 10 minutes

/** Cryptographically random, URL-safe token. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return base64url(buf)
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** SHA-256 of the verifier, base64url — the PKCE `code_challenge`. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  return base64url(new Uint8Array(digest))
}

/**
 * Cookies that carry the CSRF state and the PKCE verifier across the redirect.
 *
 * Both flows use the same names on purpose: a user can only be in the middle of
 * one sign-in at a time, and reusing one pair of names means a half-finished
 * Google attempt cannot leave a stale verifier that a later Microsoft callback
 * would read. Writing a new attempt overwrites the old one.
 */
export const oauthCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: OAUTH_COOKIE_TTL,
}

/** Stash the state and verifier, and return they values the URL needs. */
export function stashOAuthRoundTrip(
  setCookie: (
    name: string,
    value: string,
    opts: Record<string, unknown>,
  ) => void,
): { state: string; verifier: string } {
  const state = randomToken()
  const verifier = randomToken(48)

  setCookie(STATE_COOKIE, state, oauthCookieOptions)
  setCookie(VERIFIER_COOKIE, verifier, oauthCookieOptions)

  return { state, verifier }
}

/** The PKCE verifier stashed at the start of the flow. */
export function readVerifier(
  getCookie: (name: string) => string | undefined,
): string | undefined {
  return getCookie(VERIFIER_COOKIE)
}

/** The CSRF state stashed at the start of the flow. */
export function readState(
  getCookie: (name: string) => string | undefined,
): string | undefined {
  return getCookie(STATE_COOKIE)
}

/** Remove both after a flow ends, successfully or not. */
export function clearOAuthCookies(
  deleteCookie: (name: string, opts?: { path?: string }) => void,
): void {
  for (const name of [STATE_COOKIE, VERIFIER_COOKIE]) {
    deleteCookie(name, { path: '/' })
  }
}
