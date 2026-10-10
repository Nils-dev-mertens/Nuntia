import { describe, expect, test } from 'bun:test'

import {
  createGmailApiClient,
  GmailAuthError,
  GmailNotFoundError,
  GmailRateLimitError,
  wrapGmailError,
} from './client.ts'

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
      response: { status: 403, data: { error: { errors: [{ reason: 'forbidden' }] } } },
    })

    expect(error).not.toBeInstanceOf(GmailRateLimitError)
    expect(error.name).toBe('Error')
  })

  test('still maps 429 to a rate limit', () => {
    expect(wrapGmailError({ code: 429, message: 'Too many requests' })).toBeInstanceOf(
      GmailRateLimitError,
    )
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
