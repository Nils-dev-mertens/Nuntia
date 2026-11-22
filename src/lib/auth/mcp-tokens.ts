/**
 * Credentials for AI agents.
 *
 * An MCP client cannot hold a browser cookie, and asking a person to copy one
 * out of developer tools is not a sensible way to connect an agent. A token
 * created here is its own row: it has a label, it can be revoked without
 * touching a signed-in device, and it does not expire on the browser's schedule.
 *
 * The value is `mcp_<id>.<secret>`. The id selects the row and the secret is
 * compared against a SHA-256 stored at creation, so the database never holds a
 * usable credential. Tokens belong to a user and reach exactly what that user
 * can already reach.
 */

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'

import { and, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { mcpTokens } from '#/db/schema.ts'

const PREFIX = 'mcp_'

/** Enough for a laptop, a desktop agent and a couple of experiments. */
const MAX_TOKENS_PER_USER = 10
const MAX_NAME_LENGTH = 60

/** How stale `last_used_at` may be before a request writes it again. */
const TOUCH_INTERVAL_MS = 60 * 60_000

export type McpTokenSummary = {
  id: string
  name: string
  createdAt: Date
  lastUsedAt: Date | null
}

export type CreatedMcpToken = McpTokenSummary & {
  /** The only time this is available: it is not stored and cannot be shown again. */
  token: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function summary(row: {
  id: string
  name: string
  createdAt: Date
  lastUsedAt: Date | null
}): McpTokenSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }
}

/**
 * Issue a token for the settings page.
 *
 * The caller has already authenticated; `userId` is taken from the session, not
 * from the form. Names are only labels, so they are trimmed and bounded rather
 * than validated against a vocabulary.
 */
export async function createMcpToken(
  userId: string,
  name: string,
): Promise<CreatedMcpToken> {
  const owner = userId.toLowerCase()
  const label = name.trim().slice(0, MAX_NAME_LENGTH) || 'AI agent'

  const existing = await listMcpTokens(owner)
  if (existing.length >= MAX_TOKENS_PER_USER) {
    throw new Error(
      `You can keep at most ${MAX_TOKENS_PER_USER} agent tokens. Revoke one you no longer use.`,
    )
  }

  const id = randomUUID()
  const secret = randomBytes(32).toString('base64url')
  const createdAt = new Date()

  await db.insert(mcpTokens).values({
    id,
    userId: owner,
    name: label,
    tokenHash: hashToken(secret),
    createdAt,
  })

  return {
    id,
    name: label,
    createdAt,
    lastUsedAt: null,
    token: `${PREFIX}${id}.${secret}`,
  }
}

/** Active tokens for the settings page, newest first. Never includes the secret. */
export async function listMcpTokens(
  userId: string,
): Promise<McpTokenSummary[]> {
  const rows = await db.query.mcpTokens.findMany({
    where: eq(mcpTokens.userId, userId.toLowerCase()),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  })

  return rows.map(summary)
}

/**
 * Remove a token. Ownership is part of the delete, so an id from the browser
 * cannot revoke somebody else's agent.
 */
export async function revokeMcpToken(
  userId: string,
  id: string,
): Promise<boolean> {
  const removed = await db
    .delete(mcpTokens)
    .where(
      and(
        eq(mcpTokens.id, id.trim()),
        eq(mcpTokens.userId, userId.toLowerCase()),
      ),
    )
    .returning({ id: mcpTokens.id })

  return removed.length > 0
}

/**
 * Resolve a bearer token to its owner, or null.
 *
 * Called on every MCP request. The row is read each time so revoking a token
 * takes effect on the next call, exactly like deleting a session. The
 * prefix check keeps an ordinary session cookie from being looked up here.
 */
export async function userFromMcpToken(raw: string): Promise<string | null> {
  if (!raw.startsWith(PREFIX)) return null

  const rest = raw.slice(PREFIX.length)
  const dot = rest.indexOf('.')
  if (dot <= 0) return null

  const id = rest.slice(0, dot)
  const secret = rest.slice(dot + 1)
  if (!secret) return null

  const row = await db.query.mcpTokens.findFirst({
    where: eq(mcpTokens.id, id),
  })
  if (!row) return null
  if (!hashesMatch(row.tokenHash, hashToken(secret))) return null

  const now = Date.now()
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .update(mcpTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(mcpTokens.id, row.id))
  }

  return row.userId
}
