import { describe, expect, test } from 'bun:test'

import { AiRequestError, postJson } from './http.ts'
import type { FetchLike } from './http.ts'

function respond(status: number, body: string, retryAfter?: string) {
  return {
    status,
    headers: retryAfter
      ? { get: (name: string) => (name === 'retry-after' ? retryAfter : null) }
      : undefined,
    text: async () => body,
  }
}

describe('postJson', () => {
  test('retries a 429 and returns the parsed body', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return calls < 2 ? respond(429, 'slow down') : respond(200, '{"ok":true}')
    }

    const result = await postJson({
      url: 'https://example.test',
      headers: {},
      body: { a: 1 },
      fetchImpl,
      retry: { maxRetries: 2, backoffMs: () => 0 },
    })

    expect(result).toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  test('gives up after the retry budget and throws with the status', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return respond(529, 'overloaded')
    }

    const promise = postJson({
      url: 'https://example.test',
      headers: {},
      body: {},
      fetchImpl,
      retry: { maxRetries: 1, backoffMs: () => 0 },
    })

    await expect(promise).rejects.toBeInstanceOf(AiRequestError)
    // One initial attempt plus one retry.
    expect(calls).toBe(2)
  })

  test('does not retry a client error', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return respond(400, 'bad request')
    }

    await expect(
      postJson({
        url: 'https://example.test',
        headers: {},
        body: {},
        fetchImpl,
        retry: { maxRetries: 3, backoffMs: () => 0 },
      }),
    ).rejects.toThrow(/400/)
    expect(calls).toBe(1)
  })

  test('passes Retry-After through to the backoff', async () => {
    const waits: Array<{ attempt: number; retryAfterMs: number | null }> = []
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return calls === 1 ? respond(429, 'slow', '3') : respond(200, '{}')
    }

    await postJson({
      url: 'https://example.test',
      headers: {},
      body: {},
      fetchImpl,
      retry: {
        maxRetries: 1,
        backoffMs: (attempt, retryAfterMs) => {
          waits.push({ attempt, retryAfterMs })
          return 0
        },
      },
    })

    expect(waits).toEqual([{ attempt: 0, retryAfterMs: 3000 }])
  })

  test('rejects a non-JSON body from a successful response', async () => {
    const fetchImpl: FetchLike = async () => respond(200, 'not json')

    await expect(
      postJson({ url: 'https://example.test', headers: {}, body: {}, fetchImpl }),
    ).rejects.toBeInstanceOf(AiRequestError)
  })
})
