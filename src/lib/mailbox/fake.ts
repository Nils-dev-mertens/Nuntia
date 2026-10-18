/**
 * Fake Gmail client for tests.
 *
 * Exists because `GmailClient` is a narrow interface. The fake records calls so
 * tests can assert *how* sync behaved — concurrency, paging, which threads were
 * refetched — not just the end result.
 */

import type {
  AttachmentPayload,
  GmailClient,
  GmailThread,
  HistoryPage,
  SendResult,
  ThreadListPage,
} from './client.ts'
import { GmailNotFoundError } from './client.ts'

export type FakeOptions = {
  threads?: GmailThread[]
  /** Threads per page returned by listThreads. */
  pageSize?: number
  historyId?: string
  /** Canned history pages keyed by the requested startHistoryId. */
  history?: Record<string, HistoryPage>
  attachments?: Record<string, AttachmentPayload>
  /** Throw this instead of returning a thread, to exercise error paths. */
  failThread?: (threadId: string) => Error | null
}

export class FakeGmailClient implements GmailClient {
  readonly calls: string[] = []

  /** Raw messages passed to `sendMessage`, for assertions. */
  readonly sent: Array<{ raw: string; threadId?: string }> = []

  private threads: Map<string, GmailThread>
  private pageSize: number
  private historyIdValue: string
  private historyPages: Record<string, HistoryPage>
  private attachmentData: Record<string, AttachmentPayload>
  private failThread?: (threadId: string) => Error | null

  constructor(opts: FakeOptions = {}) {
    this.threads = new Map((opts.threads ?? []).map((t) => [t.id, t]))
    this.pageSize = opts.pageSize ?? 100
    this.historyIdValue = opts.historyId ?? '1000'
    this.historyPages = opts.history ?? {}
    this.attachmentData = opts.attachments ?? {}
    this.failThread = opts.failThread
  }

  /** Add or replace a thread mid-test. */
  setThread(thread: GmailThread): void {
    this.threads.set(thread.id, thread)
  }

  async getProfileHistoryId(): Promise<string> {
    this.calls.push('getProfileHistoryId')
    return this.historyIdValue
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
      threads: page.map((t) => ({ id: t.id, historyId: t.historyId })),
      nextPageToken:
        nextStart < all.length ? String(nextStart) : null,
      resultSizeEstimate: all.length,
    }
  }

  async getThread(threadId: string): Promise<GmailThread> {
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
}