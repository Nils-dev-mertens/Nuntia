/**
 * Gmail API client.
 *
 * An interface plus a real implementation, so sync can be tested against a fake
 * without touching the network. Everything the sync layer needs is expressed
 * here — it never imports `googleapis` types directly.
 */

import type { ParsedMessage } from '#/lib/mail/index.ts'
import type { createGmailClient } from '#/lib/auth/google.ts'

/** The authenticated Gmail client, as returned by `createGmailClient`. */
type GmailApi = Awaited<ReturnType<typeof createGmailClient>>

/** A single MIME part from Gmail's structured payload. */
export type GmailPart = {
  partId: string
  mimeType: string
  filename: string | null
  /** base64url body data, absent when the part is empty */
  data?: string
  headers: Record<string, string>
  children: GmailPart[]
}

/** A message from `threads.get` with `format: 'full'`. */
export type GmailMessage = {
  id: string
  threadId: string
  labelIds: string[]
  internalDate: string | null
  snippet: string | null
  payload: GmailPart | null
}

export type GmailThread = {
  id: string
  historyId: string
  messages: GmailMessage[]
}

/** One page of thread listings. */
export type ThreadListPage = {
  threads: Array<{ id: string; historyId: string }>
  nextPageToken?: string | null
  resultSizeEstimate?: number | null
}

export type HistoryPage = {
  history: Array<{
    id: string
    messages: Array<{ id: string; threadId: string }>
  }>
  nextPageToken?: string | null
  historyId?: string | null
}

export type AttachmentPayload = {
  data: string
  size: number
}

/** What Gmail returns after accepting a message. */
export type SendResult = {
  id: string
  threadId: string | null
  labelIds: string[]
}

/**
 * What sync needs from Gmail.
 *
 * Deliberately narrow — six methods, no more. Anything the sync layer starts
 * needing gets added here so a fake stays easy to write.
 */
export interface GmailClient {
  /** Current mailbox history id, used as the incremental sync cursor. */
  getProfileHistoryId: () => Promise<string>

  /** List thread ids, newest first. */
  listThreads: (opts: {
    pageToken?: string
    maxResults?: number
    query?: string
  }) => Promise<ThreadListPage>

  /** Fetch a full thread with all message payloads. */
  getThread: (threadId: string) => Promise<GmailThread>

  /** Changes since a history id. */
  listHistory: (opts: {
    startHistoryId: string
    pageToken?: string
  }) => Promise<HistoryPage>

  /** Download one attachment's bytes. */
  getAttachment: (messageId: string, attachmentId: string) => Promise<AttachmentPayload>

  /**
   * Send a raw RFC 5322 message.
   *
   * `raw` is base64url-encoded by the caller-facing helper in `send.ts`; the
   * interface takes the plain string so the fake does not have to know about
   * Gmail's encoding. Passing `threadId` makes the reply land in the existing
   * thread rather than starting a new one.
   */
  sendMessage: (
    raw: string,
    opts?: { threadId?: string },
  ) => Promise<SendResult>

  /** The authenticated account's address. */
  getEmailAddress: () => Promise<string>
}

/**
 * Real implementation backed by `googleapis`.
 *
 * Uses `format: 'full'` rather than `'raw'`: attachment bodies are not inlined
 * in the structured payload, so they are fetched on demand. That keeps thread
 * responses small and matches the schema's nullable `localPath` — an attachment
 * with no cached file is simply not downloaded yet.
 */
/**
 * How the client reacts to a rate-limited request.
 *
 * Injectable so tests can drive the retry loop without real timers.
 */
export type GmailRetryPolicy = {
  /** Attempts to make _after_ the first failure. */
  maxRetries: number
  /** Milliseconds to wait before retrying attempt `attempt` (0-indexed). */
  backoffMs: (attempt: number, retryAfterMs: number | null) => number
}

/** Base for the exponential backoff; doubled per attempt, then jittered. */
const BASE_BACKOFF_MS = 1_500
/** Ceiling for a single backoff, so a bad retry cannot hang a request. */
const MAX_BACKOFF_MS = 30_000

const DEFAULT_RETRY: GmailRetryPolicy = {
  maxRetries: 4,
  backoffMs: (attempt, retryAfterMs) => {
    // Google's own guidance wins when it sends `Retry-After`.
    if (retryAfterMs !== null) return Math.min(retryAfterMs, MAX_BACKOFF_MS)

    const capped = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
    // Full jitter, so concurrent retries do not re-collide on the same tick.
    return Math.round(capped * (0.5 + Math.random() * 0.5))
  },
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createGmailApiClient(
  gmail: GmailApi,
  userEmail: string,
  retry: GmailRetryPolicy = DEFAULT_RETRY,
): GmailClient {
  /**
   * Run one request, retrying while Gmail is rate-limiting us.
   *
   * Every call goes through here, so a quota spike on any endpoint — the
   * backfill listing, a thread fetch, the history cursor — backs off and retries
   * rather than failing the whole sync. Only `GmailRateLimitError` is retried;
   * auth, 404 and real 5xx errors keep their own behaviour.
   */
  const req = async <T>(fn: () => Promise<{ data: T }>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const { data } = await fn()
        return data
      } catch (error) {
        const wrapped = wrapGmailError(error)

        if (
          wrapped instanceof GmailRateLimitError &&
          attempt < retry.maxRetries
        ) {
          await sleep(retry.backoffMs(attempt, wrapped.retryAfterMs))
          continue
        }

        throw wrapped
      }
    }
  }

  return {
    async getProfileHistoryId() {
      const data = await req(() =>
        gmail.users.getProfile({ userId: 'me' }),
      )
      return data.historyId ?? ''
    },

    async listThreads({ pageToken, maxResults = 100, query }) {
      const data = await req(() =>
        gmail.users.threads.list({
          userId: 'me',
          maxResults,
          pageToken: pageToken ?? undefined,
          q: query,
        }),
      )

  return {
    threads: (data.threads ?? []).map((t) => ({
      id: t.id ?? '',
      historyId: t.historyId ?? '',
    })),
    nextPageToken: data.nextPageToken,
    resultSizeEstimate: data.resultSizeEstimate,
  }
    },

    async getThread(threadId) {
      const data = await req(() =>
        gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'full',
        }),
      )

      return {
        id: data.id ?? threadId,
        historyId: data.historyId ?? '',
        messages: (data.messages ?? []).map((m) => ({
          id: m.id ?? '',
          threadId: m.threadId ?? threadId,
          labelIds: m.labelIds ?? [],
          internalDate: m.internalDate ?? null,
          snippet: m.snippet ?? null,
          payload: m.payload ? toGmailPart(m.payload) : null,
        })),
      }
    },

    async listHistory({ startHistoryId, pageToken }) {
      const data = await req(() =>
        gmail.users.history.list({
          userId: 'me',
          startHistoryId,
          pageToken: pageToken ?? undefined,
          historyTypes: ['messageAdded', 'labelAdded', 'labelRemoved'],
        }),
      )

      return {
        history: (data.history ?? []).map((h) => ({
          id: h.id ?? '',
          // Schema$History.messages entries carry id and threadId directly.
          messages: (h.messages ?? [])
            .map((m) => ({ id: m.id ?? '', threadId: m.threadId ?? '' }))
            .filter((m) => m.threadId !== ''),
        })),
        nextPageToken: data.nextPageToken,
        historyId: data.historyId,
      }
    },

    async getAttachment(messageId, attachmentId) {
      // Note the param is `id`, not `attachmentId`, in the Gmail typings.
      const data = await req(() =>
        gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: attachmentId,
        }),
      )

      return { data: data.data ?? '', size: data.size ?? 0 }
    },

    async getEmailAddress() {
      return userEmail
    },

    async sendMessage(raw, opts) {
      // Gmail wants base64url, not standard base64: `+` and `/` must be
      // translated and the padding dropped, or the API rejects the request.
      const encoded = Buffer.from(raw, 'utf-8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')

      const data = await req(() =>
        gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: encoded, threadId: opts?.threadId },
        }),
      )

      return {
        id: data.id ?? '',
        threadId: data.threadId ?? null,
        labelIds: data.labelIds ?? [],
      }
    },
  }
}

/** Recursively convert Gmail's payload tree into our own shape. */
function toGmailPart(part: {
  partId?: string | null
  mimeType?: string | null
  filename?: string | null
  body?: {
    data?: string | null
    attachmentId?: string | null
    size?: number | null
  } | null
  headers?: Array<{ name?: string | null; value?: string | null }> | null
  parts?: unknown[] | null
}): GmailPart {
  const headers: Record<string, string> = {}
  for (const h of part.headers ?? []) {
    if (h.name) headers[h.name.toLowerCase()] = h.value ?? ''
  }

  const node: GmailPart = {
    partId: part.partId ?? '',
    mimeType: part.mimeType ?? 'application/octet-stream',
    filename: part.filename ?? null,
    headers,
    children: [],
  }

  // `body.data` is only present for non-ASCII text parts; attachments instead
  // carry an attachmentId and are fetched separately.
  if (part.body?.data) node.data = part.body.data
  if (part.body?.attachmentId) node.headers['x-attachment-id'] = part.body.attachmentId

  for (const child of (part.parts ?? []) as Array<typeof part>) {
    node.children.push(toGmailPart(child))
  }

  return node
}

/**
 * Turn a Gmail error into something a human can act on.
 *
 * The sync layer surfaces these, and "invalid_grant" in particular means the
 * user revoked access — it needs different handling from a transient 503.
 */
export function wrapGmailError(error: unknown): Error {
  // `error` is `unknown`, so this assertion is the only way to reach the shape
  // Google actually throws. It stays nullish-able on purpose: every level below
  // is optional in practice, and `.at(0)` avoids claiming the array is non-empty.
  const anyErr = error as
    | {
        code?: number
        message?: string
        errors?: Array<{ reason?: string }>
        response?: {
          status?: number
          headers?: Record<string, unknown>
          data?: { error?: { errors?: Array<{ reason?: string }> } }
        }
      }
    | null
    | undefined

  const status =
    anyErr?.response?.status ??
    (typeof anyErr?.code === 'number' ? anyErr.code : undefined)

  const reason =
    anyErr?.response?.data?.error?.errors?.at(0)?.reason ??
    anyErr?.errors?.at(0)?.reason

  if (reason === 'invalid_grant' || status === 401) {
    return new GmailAuthError(
      'Gmail rejected the stored credentials. The user may have revoked access — they need to sign in again.',
    )
  }

  // Gmail reports an exhausted per-user rate limit or daily quota as **403**, not
  // 429, with a reason of `rateLimitExceeded`/`quotaExceeded` — or, on the newer
  // quota model, only a message naming the metric. Treating only 429 as a rate
  // limit meant the real Gmail response surfaced as a hard "Sync failed" instead
  // of being retried.
  const message = anyErr?.message ?? ''
  const isQuota =
    reason === 'rateLimitExceeded' ||
    reason === 'quotaExceeded' ||
    /quota exceeded|rate limit exceeded|user rate limit|too many requests/i.test(
      message,
    )

  if (status === 429 || (status === 403 && isQuota)) {
    return new GmailRateLimitError(
      'Gmail is rate-limiting requests (quota exceeded). Lumen will retry on the next sync.',
      retryAfterMsOf(anyErr?.response?.headers),
    )
  }

  if (status === 404) {
    return new GmailNotFoundError(
      'The requested Gmail resource no longer exists.',
    )
  }

  return new Error(
    `Gmail request failed${status ? ` (${status})` : ''}: ${
      anyErr?.message ?? 'unknown error'
    }`,
  )
}

/** Credentials rejected or revoked — the user must re-authenticate. */
export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GmailAuthError'
  }
}

/**
 * Parse a `Retry-After` header, which may be a number of seconds or an HTTP
 * date. Returns null when absent or unrecognisable.
 */
function retryAfterMsOf(headers: Record<string, unknown> | undefined): number | null {
  // Header names are case-insensitive; gaxios lowercases them, but be defensive.
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After']

  if (typeof raw === 'number') return Math.max(0, raw * 1000)
  if (typeof raw !== 'string') return null

  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const date = Date.parse(raw)
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now())
}

/** Rate limited — callers should back off, not retry immediately. */
export class GmailRateLimitError extends Error {
  /** Google's `Retry-After`, if it sent one, in milliseconds. */
  readonly retryAfterMs: number | null

  constructor(message: string, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'GmailRateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

/** A thread or message was deleted between listing and fetching. */
export class GmailNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GmailNotFoundError'
  }
}

/** Re-exported so callers can build a ParsedMessage from a Gmail message. */
export type { ParsedMessage }