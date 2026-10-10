/**
 * Shared HTTP for the AI services (Jev and the LLM providers).
 *
 * Every AI call is a JSON POST that can be rate-limited or briefly overloaded, so
 * the retry/backoff lives here once rather than in each provider. The `fetch`
 * implementation is injectable so the clients are testable with no network and no
 * keys, which matters because both services are bring-your-own-key.
 *
 * This mirrors the Gmail client's approach deliberately: same exponential backoff
 * with full jitter, same respect for `Retry-After`. The transports differ; the
 * resilience policy should not.
 */

/** A request that reached a service but failed. `status` is 0 for local failures. */
export class AiRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AiRequestError'
    this.status = status
  }
}

/** The slice of `fetch` we use. Injectable so tests need no network. */
export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
  },
) => Promise<{
  status: number
  headers?: { get: (name: string) => string | null }
  text: () => Promise<string>
}>

export type JsonRetryPolicy = {
  /** Attempts after the first failure. */
  maxRetries: number
  backoffMs: (attempt: number, retryAfterMs: number | null) => number
}

const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 20_000

export const DEFAULT_JSON_RETRY: JsonRetryPolicy = {
  maxRetries: 3,
  backoffMs: (attempt, retryAfterMs) => {
    if (retryAfterMs !== null) return Math.min(retryAfterMs, MAX_BACKOFF_MS)
    const capped = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
    return Math.round(capped * (0.5 + Math.random() * 0.5))
  },
}

/** Rate limits, overload, and the transient 5xx family are worth retrying. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryAfterMsOf(
  headers: { get: (name: string) => string | null } | undefined,
): number | null {
  const raw = headers?.get('retry-after')
  if (!raw) return null

  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const date = Date.parse(raw)
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now())
}

/** POST a JSON body and parse a JSON reply, retrying transient failures. */
export async function postJson(opts: {
  url: string
  headers: Record<string, string>
  body: unknown
  fetchImpl?: FetchLike
  retry?: JsonRetryPolicy
}): Promise<unknown> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? globalThis.fetch

  const retry = opts.retry ?? DEFAULT_JSON_RETRY

  for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(opts.body),
    })

    if (RETRYABLE_STATUS.has(response.status) && attempt < retry.maxRetries) {
      await sleep(retry.backoffMs(attempt, retryAfterMsOf(response.headers)))
      continue
    }

    const text = await response.text()
    const ok = response.status >= 200 && response.status < 300

    if (!ok) {
      throw new AiRequestError(
        response.status,
        `AI service request failed (${response.status}): ${
          text.slice(0, 200) || 'no response body'
        }`,
      )
    }

    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new AiRequestError(
        response.status,
        'The AI service returned a non-JSON response.',
      )
    }
  }
}

/** True for a plain object (not an array or null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow a JSON value to an object, or throw with a readable message. */
export function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AiRequestError(200, `The AI service returned an unexpected ${what}.`)
  }
  return value
}
