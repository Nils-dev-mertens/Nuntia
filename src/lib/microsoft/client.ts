/**
 * Microsoft Graph mailbox client.
 *
 * Implements the same `MailboxClient` as the Gmail adapter, so sync, the
 * decision pipeline and the conversation view never learn which service a
 * mailbox belongs to.
 *
 * Three design points worth knowing:
 *
 * - **The cursor is a timestamp.** Gmail hands out an opaque `historyId` that
 *   `history.list` resumes from. Graph's delta endpoints are a better long-term
 *   fit, but establishing a `deltaLink` means enumerating the mailbox once; a
 *   `receivedDateTime ge <ISO>` listing is exact for the thing this app cares
 *   about (new mail, including a new message in an old thread) and costs one
 *   page. Edits that add no message are not picked up by either approach in a
 *   way the app uses.
 * - **Threads are conversations.** Graph has no threads endpoint: a
 *   `conversationId` groups messages, so a thread is one filtered listing.
 * - **Sending is draft-based.** `createReply` gives Graph's own threading and
 *   recipient handling; the composed body is then written over the generated
 *   one, so our greeting/signature/quote is what the recipient receives, not a
 *   second quotation on top of it.
 */

import type {
  AttachmentPayload,
  HistoryPage,
  MailboxClient,
  ProviderMessage,
  ProviderThread,
  ReplyPayload,
  SendResult,
  ThreadListPage,
} from '#/lib/mailbox/types.ts'

import { toProviderMessage } from './message.ts'
import type { GraphMessage } from './message.ts'

/** Graph REST origin. Tests point this at a local handler. */
export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0'

/** How far back an initial backfill walks. Mirrors Gmail's `newer_than:30d`. */
const BACKFILL_DAYS = 30

/**
 * Graph's simple-attachment ceiling.
 *
 * `POST /messages/{id}/attachments` accepts up to 3 MB; anything larger needs an
 * upload session. The composer already caps files at 25 MB for Gmail, so a
 * larger file is refused with a sentence naming the limit rather than failing
 * deep inside the send.
 */
export const GRAPH_MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024

/** A Microsoft token was rejected or the grant is gone. */
export class MicrosoftAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MicrosoftAuthError'
  }
}

/** Graph asked us to slow down. */
export class MicrosoftRateLimitError extends Error {
  readonly retryAfterMs: number | null

  constructor(message: string, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'MicrosoftRateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

/** A cursor the provider will not accept. Sync recovers with a backfill. */
export class MailboxCursorExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailboxCursorExpiredError'
  }
}

type GraphPage<T> = {
  value?: T[]
  '@odata.nextLink'?: string
  '@odata.count'?: number
  error?: { code?: string; message?: string }
}

export type GraphClientOptions = {
  /** Returns a bearer token, refreshing it when needed. */
  getAccessToken: () => Promise<string>
  /** The account's address; Graph's profile is not fetched on every run. */
  email: string
  fetchImpl?: typeof fetch
  baseUrl?: string
  /** Days of mail an initial backfill covers. */
  backfillDays?: number
  /** Injectable sleep, so retry tests do not wait. */
  sleepImpl?: (ms: number) => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryAfterMsOf(response: Response): number | null {
  const raw = response.headers.get('retry-after')
  if (!raw) return null

  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const date = Date.parse(raw)
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now())
}

/** Quote a value for an OData string literal. */
function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Graph's recipient shape, which is the same for to/cc/bcc. */
function graphRecipients(
  addresses: string[],
): Array<{ emailAddress: { address: string } }> {
  return addresses.map((address) => ({ emailAddress: { address } }))
}

export function createGraphClient(opts: GraphClientOptions): MailboxClient {
  const fetchImpl = opts.fetchImpl ?? fetch
  const baseUrl = opts.baseUrl ?? GRAPH_BASE_URL
  const backfillDays = opts.backfillDays ?? BACKFILL_DAYS
  const wait = opts.sleepImpl ?? sleep
  const email = opts.email

  /**
   * One authenticated request, with rate-limit retries.
   *
   * Graph answers 429 with `Retry-After` for per-mailbox throttling and 503 while
   * a mailbox is being moved. Both are retried; a 401 is not — that means the
   * refresh token is gone and the user has to reconnect.
   */
  const request = async <T>(
    path: string,
    init: RequestInit = {},
    attempt = 0,
  ): Promise<T> => {
    const token = await opts.getAccessToken()
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`

    const response = await fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    })

    if (response.status === 401) {
      throw new MicrosoftAuthError(
        'Microsoft rejected the stored credentials. The user may have revoked access — they need to sign in again.',
      )
    }

    if (response.status === 429 || response.status === 503) {
      if (attempt < 4) {
        const retryAfter = retryAfterMsOf(response)
        const backoff = Math.min(30_000, 1_500 * 2 ** attempt)
        await wait(
          retryAfter ?? Math.round(backoff * (0.5 + Math.random() * 0.5)),
        )
        return request<T>(url, init, attempt + 1)
      }

      throw new MicrosoftRateLimitError(
        'Outlook is rate-limiting requests. Nuntia will retry on the next sync.',
        retryAfterMsOf(response),
      )
    }

    if (response.status === 404) {
      throw new MailboxCursorExpiredError(
        'The requested Outlook resource no longer exists.',
      )
    }

    const text = await response.text()
    const payload = text
      ? (JSON.parse(text) as GraphPage<T>)
      : ({} as GraphPage<T>)

    if (!response.ok) {
      const detail =
        payload.error?.message ??
        (payload as unknown as { error_description?: string })
          .error_description ??
        'unknown error'
      throw new Error(`Outlook request failed (${response.status}): ${detail}`)
    }

    return payload as T
  }

  /** Every page of a listing, following Graph's own next links. */
  const pages = async <T>(
    path: string,
  ): Promise<{ value: T[]; count: number }> => {
    const value: T[] = []
    let next: string | undefined = path
    let count = 0

    while (next) {
      const page: GraphPage<T> = await request<GraphPage<T>>(next)
      value.push(...(page.value ?? []))
      count = page['@odata.count'] ?? count
      next = page['@odata.nextLink']
    }

    return { value, count }
  }

  /** The Graph message that a reply should be threaded onto. */
  const findReplyTarget = async (
    threadId: string,
    inReplyTo: string | null,
  ): Promise<string> => {
    const params = new URLSearchParams({
      $select: 'id,internetMessageId,receivedDateTime',
      $filter: `conversationId eq ${odataString(threadId)}`,
      $orderby: 'receivedDateTime desc',
      $top: '20',
    })

    const page = await request<GraphPage<GraphMessage>>(
      `/me/messages?${params}`,
    )
    const messages = page.value ?? []

    const wanted = inReplyTo?.replace(/^</, '').replace(/>$/, '') ?? null
    const match = wanted
      ? messages.find(
          (message) =>
            (message.internetMessageId ?? '')
              .replace(/^</, '')
              .replace(/>$/, '') === wanted,
        )
      : undefined

    // Newest first, so `.at(0)` is the most recent message — the one a reply
    // belongs after when the RFC id is not stored (an older sync, a provider
    // that rewrote it).
    const target = match ?? messages.at(0)
    if (!target) {
      throw new Error('This conversation has no message to reply to.')
    }

    return target.id
  }

  return {
    provider: 'microsoft',
    capabilities: { structuredReply: true, delta: false },

    async getProfileHistoryId() {
      // The incremental cursor is "everything received after this instant".
      return new Date().toISOString()
    },

    async listThreads({ pageToken, maxResults = 100 }) {
      const since = new Date(
        Date.now() - backfillDays * 24 * 60 * 60 * 1000,
      ).toISOString()

      const params = new URLSearchParams({
        $select: 'id,conversationId',
        $filter: `receivedDateTime ge ${since}`,
        $orderby: 'receivedDateTime desc',
        $top: String(Math.min(maxResults, 100)),
      })

      const page = await request<GraphPage<GraphMessage>>(
        pageToken ?? `/me/messages?${params}`,
      )

      const seen = new Set<string>()
      const threads: Array<{ id: string; cursor: string }> = []
      for (const message of page.value ?? []) {
        const id = message.conversationId
        if (!id || seen.has(id)) continue
        seen.add(id)
        threads.push({ id, cursor: '' })
      }

      return {
        threads,
        nextPageToken: page['@odata.nextLink'] ?? null,
        // Graph does not return a total for a filtered listing.
        resultSizeEstimate: null,
      } satisfies ThreadListPage
    },

    async getThread(threadId) {
      const params = new URLSearchParams({
        $select:
          'id,conversationId,internetMessageId,subject,body,bodyPreview,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,isDraft,hasAttachments',
        $filter: `conversationId eq ${odataString(threadId)}`,
        $orderby: 'receivedDateTime asc',
        $top: '50',
        $expand:
          'attachments($select=id,name,contentType,size,isInline,contentId)',
      })

      const { value } = await pages<GraphMessage>(`/me/messages?${params}`)

      const messages: ProviderMessage[] = value.map((message) =>
        toProviderMessage(message, message.attachments ?? []),
      )

      return {
        id: threadId,
        cursor: new Date().toISOString(),
        messages,
      } satisfies ProviderThread
    },

    async listHistory({ startHistoryId }) {
      // A cursor that is not an ISO timestamp means the stored value was not
      // written by this adapter (a provider switch). `Date.parse` alone is too
      // lax here: it happily reads a Gmail history id like "12345" as a year, so
      // the shape is checked as well as the parse.
      if (
        !/^\d{4}-\d{2}-\d{2}T/.test(startHistoryId) ||
        Number.isNaN(Date.parse(startHistoryId))
      ) {
        throw new MailboxCursorExpiredError(
          'The stored Outlook sync cursor is not a timestamp.',
        )
      }

      const params = new URLSearchParams({
        $select: 'id,conversationId',
        $filter: `receivedDateTime ge ${startHistoryId}`,
        $orderby: 'receivedDateTime desc',
        $top: '100',
      })

      const { value } = await pages<GraphMessage>(`/me/messages?${params}`)

      return {
        history: [
          {
            id: startHistoryId,
            messages: value
              .filter((message) => Boolean(message.conversationId))
              .map((message) => ({
                id: message.id,
                threadId: message.conversationId as string,
              })),
          },
        ],
        nextPageToken: null,
        cursor: new Date().toISOString(),
      } satisfies HistoryPage
    },

    async getAttachment(messageId, attachmentId) {
      const data = await request<{ contentBytes?: string; size?: number }>(
        `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      )

      return {
        data: data.contentBytes ?? '',
        size: data.size ?? 0,
      } satisfies AttachmentPayload
    },

    async getEmailAddress() {
      return email
    },

    async sendReply(payload: ReplyPayload) {
      const targetId = await findReplyTarget(
        payload.threadId,
        payload.inReplyTo,
      )

      // Graph threads the reply for us; the body it pre-fills is replaced with
      // the composed one so the recipient sees exactly what the user reviewed.
      const draft = await request<{ id?: string }>(
        `/me/messages/${encodeURIComponent(targetId)}/createReply`,
        { method: 'POST', body: JSON.stringify({}) },
      )

      const draftId = draft.id
      if (!draftId) {
        throw new Error('Outlook did not return a draft to send.')
      }

      await request(`/me/messages/${encodeURIComponent(draftId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          subject: payload.subject,
          body: { contentType: 'HTML', content: payload.html },
          toRecipients: graphRecipients(payload.to),
          ccRecipients: graphRecipients(payload.cc),
        }),
      })

      for (const attachment of payload.attachments) {
        if (attachment.data.byteLength > GRAPH_MAX_ATTACHMENT_BYTES) {
          throw new Error(
            `${attachment.filename} is larger than Outlook's 3 MB attachment limit.`,
          )
        }

        await request(
          `/me/messages/${encodeURIComponent(draftId)}/attachments`,
          {
            method: 'POST',
            body: JSON.stringify({
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: attachment.filename,
              contentType: attachment.contentType,
              contentBytes: Buffer.from(attachment.data).toString('base64'),
            }),
          },
        )
      }

      await request(`/me/messages/${encodeURIComponent(draftId)}/send`, {
        method: 'POST',
        body: JSON.stringify({}),
      })

      return {
        id: draftId,
        threadId: payload.threadId,
        labelIds: [],
      } satisfies SendResult
    },

    async sendNewMessage(payload) {
      // Graph's simple-attachment ceiling applies to a new message exactly as it
      // does to a reply; refused here rather than after the send has started.
      for (const attachment of payload.attachments) {
        if (attachment.data.byteLength > GRAPH_MAX_ATTACHMENT_BYTES) {
          throw new Error(
            `${attachment.filename} is larger than Outlook's 3 MB attachment limit.`,
          )
        }
      }

      await request('/me/sendMail', {
        method: 'POST',
        body: JSON.stringify({
          message: {
            subject: payload.subject,
            body: { contentType: 'HTML', content: payload.html },
            toRecipients: graphRecipients(payload.to),
            ccRecipients: graphRecipients(payload.cc),
            bccRecipients: graphRecipients(payload.bcc),
            attachments: payload.attachments.map((attachment) => ({
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: attachment.filename,
              contentType: attachment.contentType,
              contentBytes: Buffer.from(attachment.data).toString('base64'),
            })),
          },
          saveToSentItems: true,
        }),
      })

      // `sendMail` answers 202 with no body, so there is no id or thread id to
      // report. The caller navigates to the inbox, where the next sync lands it.
      return { id: '', threadId: null, labelIds: [] } satisfies SendResult
    },
  }
}
