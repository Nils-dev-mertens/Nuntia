/**
 * Server-side sessions.
 *
 * The cookie carries `<session id>.<random token>`; the database stores the
 * SHA-256 of the token plus the user it belongs to. That is what makes signing
 * out mean something and multi-device normal: each device is a row, deleting the
 * row revokes that device on its next request, and a copied cookie stops working
 * the moment its session is revoked — which a self-contained signed cookie
 * cannot do.
 *
 * The token is 32 random bytes. The cookie is httpOnly, SameSite=Lax, and
 * `Secure` outside development.
 */

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'

import {
  deleteCookie,
  getCookie,
  getRequestHeader,
  setCookie,
} from '@tanstack/react-start/server'
import { and, eq, lt, ne } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { sessions } from '#/db/schema.ts'
import { recordActiveDay } from '#/lib/beta/events.ts'

import { ensureBootstrapUser } from './users.ts'

const COOKIE_NAME = 'lumen_session'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days

/** How stale `last_seen_at` may be before a request extends the session. */
const TOUCH_INTERVAL_MS = 60 * 60_000

export type SessionData = {
  /** The one device this request came from. Revoking it signs that device out. */
  sessionId: string
  /** Lowercased email of the person signed in; owner of every mailbox here. */
  userId: string
}

function cookieOptions() {
  return {
    httpOnly: true,
    // Secure would break plain-HTTP local dev, so gate it on the protocol.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  } as const
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Compare two hex digests without leaking where they first differ. */
function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function expiryFrom(now: number): Date {
  return new Date(now + MAX_AGE_SECONDS * 1000)
}

/** Best-effort browser hint for the device list; never used for authorisation. */
function requestUserAgent(): string | null {
  try {
    return getRequestHeader('user-agent') ?? null
  } catch {
    return null
  }
}

/**
 * Start a session for a user on this device.
 *
 * The caller has already checked the password. Other rows for this user are left
 * alone: those are the user's other devices.
 */
export async function createSession(userId: string): Promise<SessionData> {
  const id = randomUUID()
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()

  await db.insert(sessions).values({
    id,
    userId: userId.toLowerCase(),
    tokenHash: hashToken(token),
    userAgent: requestUserAgent(),
    lastSeenAt: new Date(now),
    expiresAt: expiryFrom(now),
  })

  // Cheap housekeeping on the write path: an expired row is never valid, so
  // clearing it cannot sign anyone out.
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date(now)))

  setCookie(COOKIE_NAME, `${id}.${token}`, cookieOptions())

  return { sessionId: id, userId: userId.toLowerCase() }
}

/**
 * Read and validate the current device's session.
 *
 * Also makes sure the environment's bootstrap user exists first, so every entry
 * point sees the same state without each one remembering to do it.
 */
export async function getSession(): Promise<SessionData | null> {
  await ensureBootstrapUser()

  const raw = getCookie(COOKIE_NAME)
  if (!raw) return null

  const dot = raw.indexOf('.')
  if (dot <= 0) return null

  const sessionId = raw.slice(0, dot)
  const token = raw.slice(dot + 1)
  if (!token) return null

  const row = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
  })

  if (!row || row.revokedAt) return null

  const now = Date.now()
  if (row.expiresAt.getTime() <= now) return null
  if (!hashesMatch(row.tokenHash, hashToken(token))) return null

  // Sliding expiry, written at most hourly so a busy tab is not a write per
  // request. The session row is the authority; the cookie is refreshed at the
  // same time so the browser keeps sending it.
  if (now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date(now), expiresAt: expiryFrom(now) })
      .where(eq(sessions.id, sessionId))

    setCookie(COOKIE_NAME, raw, cookieOptions())
  }

  // The only funnel step the session table cannot answer: `last_seen_at` keeps
  // the latest touch, not a history, so "came back on another day" is written
  // here. At most one row per session per day, and it never fails the request.
  await recordActiveDay(sessionId, row.userId)

  return { sessionId, userId: row.userId }
}

/** End this device's session. Other devices stay signed in. */
export async function destroySession(): Promise<void> {
  const raw = getCookie(COOKIE_NAME)

  if (raw) {
    const dot = raw.indexOf('.')
    if (dot > 0) {
      await db.delete(sessions).where(eq(sessions.id, raw.slice(0, dot)))
    }
  }

  deleteCookie(COOKIE_NAME, { path: '/' })
}

/**
 * Revoke every session for a user, optionally keeping the current device.
 *
 * Real rather than a gesture because sessions are rows: "sign out everywhere
 * else" deletes them and those devices fail their next request.
 */
export async function revokeAllSessions(
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  const owner = eq(sessions.userId, userId.toLowerCase())

  await db
    .delete(sessions)
    .where(
      exceptSessionId ? and(owner, ne(sessions.id, exceptSessionId)) : owner,
    )
}

/** Signed-in devices, most recently active first. */
export async function listSessions(userId: string): Promise<
  Array<{
    id: string
    userAgent: string | null
    lastSeenAt: Date
    createdAt: Date
    expiresAt: Date
  }>
> {
  const rows = await db.query.sessions.findMany({
    where: eq(sessions.userId, userId.toLowerCase()),
    orderBy: (table, { desc }) => [desc(table.lastSeenAt)],
  })

  return rows
    .filter((row) => !row.revokedAt && row.expiresAt.getTime() > Date.now())
    .map((row) => ({
      id: row.id,
      userAgent: row.userAgent,
      lastSeenAt: row.lastSeenAt,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }))
}
