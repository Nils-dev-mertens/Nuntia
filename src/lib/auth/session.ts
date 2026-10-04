/**
 * Session handling.
 *
 * The session cookie holds only the account id and expiry — never a token.
 * Tokens live in the database, encrypted. That way a stolen cookie grants
 * nothing without the server's encryption key.
 *
 * The cookie is signed with `SESSION_SECRET`. If unset we fall back to
 * `TOKEN_ENCRYPTION_KEY` so a single generated key is enough to run locally,
 * but the two are documented separately because they have different blast
 * radii: leaking the session secret should not decrypt stored tokens.
 */

import { getCookie, setCookie, deleteCookie } from '@tanstack/react-start/server'

const COOKIE_NAME = 'lumen_session'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days

export type SessionData = {
  /** The connected account's email, lowercased. */
  accountId: string
  issuedAt: number
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET ?? process.env.TOKEN_ENCRYPTION_KEY

  if (!secret) {
    throw new Error(
      'SESSION_SECRET or TOKEN_ENCRYPTION_KEY must be set to use sessions',
    )
  }

  return secret
}

/**
 * Sign the payload with HMAC-SHA256.
 *
 * Format: `<base64url payload>.<base64url signature>`. A constant-time compare
 * on verify keeps this from leaking the signature byte by byte.
 */
async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(sessionSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  )

  return `${payload}.${base64url(new Uint8Array(sig))}`
}

/** Verify and decode. Returns null on any tampering or expiry. */
async function verify(signed: string): Promise<SessionData | null> {
  const dot = signed.lastIndexOf('.')

  if (dot === -1) return null

  const payload = signed.slice(0, dot)
  const signature = signed.slice(dot + 1)

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(sessionSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    toBufferSource(base64urlToBytes(signature)),
    new TextEncoder().encode(payload),
  )

  if (!ok) return null

  try {
    const decoded = JSON.parse(
      new TextDecoder().decode(base64urlToBytes(payload)),
    ) as SessionData

    if (typeof decoded.accountId !== 'string') return null

    // Reject expired sessions server-side; the cookie max-age alone is not
    // enough since a client can replay an old cookie verbatim.
    if (Date.now() - decoded.issuedAt > MAX_AGE_SECONDS * 1000) return null

    return decoded
  } catch {
    return null
  }
}

/**
 * Copy into a plain ArrayBuffer.
 *
 * WebCrypto's `BufferSource` excludes `Uint8Array<ArrayBufferLike>` (which may
 * be backed by a SharedArrayBuffer), so we materialise a real ArrayBuffer.
 */
function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Write the session cookie. */
export async function setSession(accountId: string): Promise<void> {
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({
        accountId: accountId.toLowerCase(),
        issuedAt: Date.now(),
      } satisfies SessionData),
    ),
  )

  setCookie(COOKIE_NAME, await sign(payload), {
    httpOnly: true,
    // Secure would break plain-HTTP local dev, so gate it on the protocol.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
}

/** Read the session, or null when not signed in. */
export async function getSession(): Promise<SessionData | null> {
  const raw = getCookie(COOKIE_NAME)
  if (!raw) return null
  return verify(raw)
}

/** Clear the session cookie. */
export function clearSession(): void {
  deleteCookie(COOKIE_NAME, { path: '/' })
}