/**
 * Fake mailbox client for tests.
 *
 * Exists because `MailboxClient` is a narrow interface. The fake records calls so
 * tests can assert *how* sync behaved — concurrency, paging, which threads were
 * refetched — not just the end result.
 */

import type {
  AttachmentPayload,
  HistoryPage,
  MailboxClient,
  NewMessagePayload,
  ProviderThread,
  SendResult,
  ThreadListPage,
} from './types.ts'
import { GmailNotFoundError } from '#/lib/gmail/client.ts'

export type FakeOptions = {
  threads?: ProviderThread[]
  /** Threads per page returned by listThreads. */
  pageSize?: number
  cursor?: string
  /** Canned history pages keyed by the requested startHistoryId. */
  history?: Record<string, HistoryPage>
  attachments?: Record<string, AttachmentPayload>
  /** Throw this instead of returning a thread, to exercise error paths. */
  failThread?: (threadId: string) => Error | null
}

export class FakeMailboxClient implements MailboxClient {
  readonly provider = 'google' as const
  readonly capabilities = { structuredReply: false, delta: true }

  readonly calls: string[] = []

  /** Raw messages passed to `sendMessage`, for assertions. */
  readonly sent: Array<{ raw: string; threadId?: string }> = []

  /** New messages passed to `sendNewMessage`, for assertions. */
  readonly started: NewMessagePayload[] = []

  /** Topic names this mailbox was asked to watch. */
  readonly watches: string[] = []

  private threads: Map<string, ProviderThread>
  private pageSize: number
  private cursorValue: string
  private historyPages: Record<string, HistoryPage>
  private attachmentData: Record<string, AttachmentPayload>
  private failThread?: (threadId: string) => Error | null

  constructor(opts: FakeOptions = {}) {
    this.threads = new Map((opts.threads ?? []).map((t) => [t.id, t]))
    this.pageSize = opts.pageSize ?? 100
    this.cursorValue = opts.cursor ?? '1000'
    this.historyPages = opts.history ?? {}
    this.attachmentData = opts.attachments ?? {}
    this.failThread = opts.failThread
  }

  /** Add or replace a thread mid-test. */
  setThread(thread: ProviderThread): void {
    this.threads.set(thread.id, thread)
  }

  async getProfileHistoryId(): Promise<string> {
    this.calls.push('getProfileHistoryId')
    return this.cursorValue
  }

  async listThreads({
    pageToken,
    maxResults = 100,
  }: {
    pageToken?: string
    maxResults?: number
    query?: string
  }): Promise<ThreadListPage> {
    this.calls.push(`listThreads:${pageToken ?? 'first'}`)

    const all = [...this.threads.values()]
    const start = pageToken ? Number(pageToken) : 0
    const size = Math.min(this.pageSize, maxResults)
    const page = all.slice(start, start + size)
    const nextStart = start + size

    return {
      threads: page.map((t) => ({ id: t.id, cursor: t.cursor })),
      nextPageToken: nextStart < all.length ? String(nextStart) : null,
      resultSizeEstimate: all.length,
    }
  }

  async getThread(threadId: string): Promise<ProviderThread> {
    this.calls.push(`getThread:${threadId}`)

    const failure = this.failThread?.(threadId)
    if (failure) throw failure

    const thread = this.threads.get(threadId)
    if (!thread) {
      throw new GmailNotFoundError(`Thread ${threadId} not found`)
    }

    return thread
  }

  async listHistory({
    startHistoryId,
    pageToken,
  }: {
    startHistoryId: string
    pageToken?: string
  }): Promise<HistoryPage> {
    this.calls.push(`listHistory:${startHistoryId}`)

    // `in` rather than a truthiness check: an index lookup on a `Record` is
    // typed as always-present, but a missing history id is a real case.
    if (!(startHistoryId in this.historyPages)) {
      throw new GmailNotFoundError(
        `History id ${startHistoryId} is no longer available`,
      )
    }
    const page = this.historyPages[startHistoryId]

    return pageToken ? { ...page, history: [], nextPageToken: null } : page
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<AttachmentPayload> {
    this.calls.push(`getAttachment:${messageId}:${attachmentId}`)

    if (!(attachmentId in this.attachmentData)) return { data: '', size: 0 }

    return this.attachmentData[attachmentId]
  }

  async getEmailAddress(): Promise<string> {
    return 'me@example.com'
  }

  async sendMessage(
    raw: string,
    opts: { threadId?: string } = {},
  ): Promise<SendResult> {
    this.sent.push({ raw, threadId: opts.threadId })

    const id = `sent-${this.sent.length}`
    return { id, threadId: opts.threadId ?? `thread-${id}`, labelIds: ['SENT'] }
  }

  async sendNewMessage(payload: NewMessagePayload): Promise<SendResult> {
    this.started.push(payload)

    const id = `new-${this.started.length}`
    return { id, threadId: `thread-${id}`, labelIds: ['SENT'] }
  }

  async startWatch({ topicName }: { topicName: string }) {
    this.watches.push(topicName)
    return { expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000) }
  }
}
