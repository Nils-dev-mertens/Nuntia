import { describe, expect, test } from 'bun:test'

import {
  createGmailApiClient,
  GmailAuthError,
  GmailNotFoundError,
  GmailRateLimitError,
  wrapGmailError,
} from '#/lib/gmail/client.ts'
import { toAttachmentRefs } from '#/lib/mailbox/message.ts'

/**
 * The shape Google actually throws for an exhausted quota.
 *
 * Note the status is 403, not 429 — the whole reason the old mapping treated it
 * as an unclassified failure. The message mirrors the real response closely
 * enough to exercise the message-based fallback.
 */
function quotaError(reason?: string, retryAfter?: string) {
  return {
    code: 403,
    message:
      "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:279708333743'.",
    response: {
      status: 403,
      headers: retryAfter ? { 'retry-after': retryAfter } : undefined,
      data: reason ? { error: { errors: [{ reason }] } } : undefined,
    },
  }
}

/** A `googleapis`-shaped stub, narrowed to only what the client calls. */
function gmailWithGetProfile(
  impl: () => Promise<{ data: { historyId: string } }>,
) {
  return {
    users: { getProfile: impl },
  } as unknown as Parameters<typeof createGmailApiClient>[0]
}

describe('wrapGmailError', () => {
  test('classifies a 403 quota response as a rate limit', () => {
    const error = wrapGmailError(quotaError('rateLimitExceeded'))
    expect(error).toBeInstanceOf(GmailRateLimitError)
  })

  test('classifies a 403 quota response by its message alone', () => {
    // The newer quota model can omit the reason and only name the metric.
    const error = wrapGmailError(quotaError())
    expect(error).toBeInstanceOf(GmailRateLimitError)
  })

  test('classifies reason quotaExceeded as a rate limit too', () => {
    expect(wrapGmailError(quotaError('quotaExceeded'))).toBeInstanceOf(
      GmailRateLimitError,
    )
  })

  test('keeps the Retry-After header, in milliseconds', () => {
    const error = wrapGmailError(quotaError('rateLimitExceeded', '7'))
    expect(error).toBeInstanceOf(GmailRateLimitError)
    expect((error as GmailRateLimitError).retryAfterMs).toBe(7000)
  })

  test('does not misclassify a plain 403 as a rate limit', () => {
    const error = wrapGmailError({
      code: 403,
      message: 'Forbidden',
      response: {
        status: 403,
        data: { error: { errors: [{ reason: 'forbidden' }] } },
      },
    })

    expect(error).not.toBeInstanceOf(GmailRateLimitError)
    expect(error.name).toBe('Error')
  })

  test('still maps 429 to a rate limit', () => {
    expect(
      wrapGmailError({ code: 429, message: 'Too many requests' }),
    ).toBeInstanceOf(GmailRateLimitError)
  })

  test('keeps the existing auth and not-found mappings', () => {
    expect(
      wrapGmailError({ response: { status: 401 }, message: 'unauthorized' }),
    ).toBeInstanceOf(GmailAuthError)
    expect(wrapGmailError({ code: 404, message: 'gone' })).toBeInstanceOf(
      GmailNotFoundError,
    )
  })
})

describe('createGmailApiClient rate-limit retry', () => {
  test('retries a rate-limited request until it succeeds', async () => {
    let attempts = 0
    const client = createGmailApiClient(
      gmailWithGetProfile(async () => {
        attempts += 1
        if (attempts < 3) throw quotaError('rateLimitExceeded')
        return { data: { historyId: '42' } }
      }),
      'me@example.com',
      { maxRetries: 3, backoffMs: () => 0 },
    )

    expect(await client.getProfileHistoryId()).toBe('42')
    expect(attempts).toBe(3)
  })

  test('gives up after the retry budget and surfaces the rate limit', async () => {
    let attempts = 0
    const client = createGmailApiClient(
      gmailWithGetProfile(async () => {
        attempts += 1
        throw quotaError('rateLimitExceeded')
      }),
      'me@example.com',
      { maxRetries: 2, backoffMs: () => 0 },
    )

    await expect(client.getProfileHistoryId()).rejects.toBeInstanceOf(
      GmailRateLimitError,
    )
    // One initial attempt plus the two retries.
    expect(attempts).toBe(3)
  })

  test('does not retry a non-rate-limit failure', async () => {
    let attempts = 0
    const client = createGmailApiClient(
      gmailWithGetProfile(async () => {
        attempts += 1
        throw new Error('boom')
      }),
      'me@example.com',
      { maxRetries: 3, backoffMs: () => 0 },
    )

    await expect(client.getProfileHistoryId()).rejects.toThrow('boom')
    expect(attempts).toBe(1)
  })

  test("passes Google's Retry-After through to the backoff", async () => {
    const waits: Array<{ attempt: number; retryAfterMs: number | null }> = []
    let attempts = 0

    const client = createGmailApiClient(
      gmailWithGetProfile(async () => {
        attempts += 1
        if (attempts === 1) throw quotaError('rateLimitExceeded', '5')
        return { data: { historyId: '1' } }
      }),
      'me@example.com',
      {
        maxRetries: 1,
        backoffMs: (attempt, retryAfterMs) => {
          waits.push({ attempt, retryAfterMs })
          return 0
        },
      },
    )

    await client.getProfileHistoryId()
    expect(waits).toEqual([{ attempt: 0, retryAfterMs: 5000 }])
  })
})

describe('createGmailApiClient payload conversion', () => {
  /** A `threads.get` response with one text part and one attachment part. */
  function gmailWithThread(attachmentSize: number) {
    return {
      users: {
        threads: {
          get: async () => ({
            data: {
              id: 't1',
              historyId: '7',
              messages: [
                {
                  id: 'm1',
                  threadId: 't1',
                  labelIds: ['INBOX'],
                  internalDate: '1700000000000',
                  snippet: 'See attached.',
                  payload: {
                    partId: '',
                    mimeType: 'multipart/mixed',
                    filename: null,
                    // Gmail reports a multipart container as size 0.
                    body: { size: 0 },
                    headers: [],
                    parts: [
                      {
                        partId: '0',
                        mimeType: 'text/plain',
                        filename: null,
                        body: { data: '', size: 21 },
                        headers: [],
                      },
                      {
                        partId: '1',
                        mimeType: 'application/pdf',
                        filename: 'report.pdf',
                        body: {
                          attachmentId: 'ANGjdJ_synthetic',
                          size: attachmentSize,
                        },
                        headers: [],
                      },
                    ],
                  },
                },
              ],
            },
          }),
        },
      },
    } as unknown as Parameters<typeof createGmailApiClient>[0]
  }

  test('carries the byte size Gmail reports for an attachment part', async () => {
    // The size only exists on `body.size`, but the app reads attachment metadata
    // off the header tree, so dropping it made every stored attachment 0 bytes
    // (and every chip in the chat view read "0 B").
    const client = createGmailApiClient(gmailWithThread(4096), 'me@example.com')

    const thread = await client.getThread('t1')
    const refs = toAttachmentRefs(thread.messages[0])

    expect(refs).toHaveLength(1)
    expect(refs[0].filename).toBe('report.pdf')
    expect(refs[0].sizeBytes).toBe(4096)
  })

  test('reports no size rather than a bogus one when the part has none', async () => {
    const client = createGmailApiClient(gmailWithThread(0), 'me@example.com')

    const refs = toAttachmentRefs((await client.getThread('t1')).messages[0])

    expect(refs[0].sizeBytes).toBe(0)
  })
})
