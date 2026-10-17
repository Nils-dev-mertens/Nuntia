import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { aiLogPath } from './ai-log.ts'
import { AiRequestError, postJson } from './http.ts'
import type { FetchLike } from './http.ts'

let logDir = ''

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'lumen-ai-http-'))
  process.env.AI_LOG_DIR = logDir
})

afterEach(() => {
  delete process.env.AI_LOG_DIR
  rmSync(logDir, { recursive: true, force: true })
})

/** The AI log as parsed entries. */
async function logEntries(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(aiLogPath(), 'utf-8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

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

  test('records a failed call, without the key or the mail it carried', async () => {
    // The whole point of the log: when the AI "does nothing", the reason is on
    // disk. The key and the prompt are the two things that must never be.
    const KEY = 'sk-do-not-log-me'
    const PROMPT = 'From my inbox: the quarterly figures are late'

    const promise = postJson({
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY}` },
      body: { model: 'o3', messages: [{ role: 'user', content: PROMPT }] },
      fetchImpl: async () => respond(400, '{"error":{"message":"bad thing"}}'),
      log: { service: 'llm:openai', model: 'o3' },
    })

    await expect(promise).rejects.toBeInstanceOf(AiRequestError)

    const entries = await logEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].service).toBe('llm:openai')
    expect(entries[0].model).toBe('o3')
    expect(entries[0].outcome).toBe('error')
    expect(entries[0].status).toBe(400)
    expect(String(entries[0].detail)).toContain('bad thing')

    const raw = JSON.stringify(entries)
    expect(raw).not.toContain(KEY)
    expect(raw).not.toContain(PROMPT)
  })

  test('records a retry as a retry, then the outcome', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return calls < 2 ? respond(429, 'slow down') : respond(200, '{"ok":true}')
    }

    await postJson({
      url: 'https://example.test',
      headers: {},
      body: {},
      fetchImpl,
      retry: { maxRetries: 2, backoffMs: () => 0 },
      log: { service: 'llm:gemini' },
    })

    const entries = await logEntries()
    expect(entries.map((entry) => entry.outcome)).toEqual(['retry', 'ok'])
    expect(entries[0].status).toBe(429)
  })

  test('a request that never reaches the service names the cause', async () => {
    // A local failure used to surface as a bare "fetch failed" several layers up.
    const promise = postJson({
      url: 'https://example.test',
      headers: {},
      body: {},
      fetchImpl: async () => {
        throw new TypeError('unable to verify the first certificate')
      },
      log: { service: 'jev', model: 'jev-latest' },
    })

    await expect(promise).rejects.toThrow(
      /Could not reach the AI service.*certificate/,
    )

    const entries = await logEntries()
    expect(entries[0].status).toBe(0)
    expect(String(entries[0].detail)).toContain('certificate')
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
      postJson({
        url: 'https://example.test',
        headers: {},
        body: {},
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(AiRequestError)
  })
})
