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

import { logAiEvent } from './ai-log.ts'

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

/**
 * POST a JSON body and parse a JSON reply, retrying transient failures.
 *
 * Every call is also written to the AI log (`ai-log.ts`), which is why this is
 * the only place that talks to a provider: one choke point, so no call can be
 * added that fails invisibly.
 */
export async function postJson(opts: {
  url: string
  headers: Record<string, string>
  body: unknown
  fetchImpl?: FetchLike
  retry?: JsonRetryPolicy
  /** Names the caller in the log: `jev`, `llm:openai`. */
  log?: { service: string; model?: string }
}): Promise<unknown> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? globalThis.fetch

  const retry = opts.retry ?? DEFAULT_JSON_RETRY

  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now()

    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await fetchImpl(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify(opts.body),
      })
    } catch (error) {
      // The request never reached the service: no DNS, no route, TLS refused.
      // Wrapped rather than rethrown so the message names the cause instead of
      // surfacing as a bare "fetch failed" several layers up.
      const detail = error instanceof Error ? error.message : String(error)
      await logAiEvent({
        ...logFields(opts.log, opts.url),
        outcome: 'error',
        status: 0,
        durationMs: Date.now() - startedAt,
        attempt: attempt + 1,
        detail,
      })
      throw new AiRequestError(0, `Could not reach the AI service: ${detail}`)
    }

    if (RETRYABLE_STATUS.has(response.status) && attempt < retry.maxRetries) {
      await logAiEvent({
        ...logFields(opts.log, opts.url),
        outcome: 'retry',
        status: response.status,
        durationMs: Date.now() - startedAt,
        attempt: attempt + 1,
        detail: retryAfterMsOf(response.headers)
          ? `retrying after Retry-After`
          : undefined,
      })
      await sleep(retry.backoffMs(attempt, retryAfterMsOf(response.headers)))
      continue
    }

    const text = await response.text()
    const ok = response.status >= 200 && response.status < 300

    if (!ok) {
      const detail = text.slice(0, 200) || 'no response body'
      await logAiEvent({
        ...logFields(opts.log, opts.url),
        outcome: 'error',
        status: response.status,
        durationMs: Date.now() - startedAt,
        attempt: attempt + 1,
        detail,
      })
      throw new AiRequestError(
        response.status,
        `AI service request failed (${response.status}): ${detail}`,
      )
    }

    await logAiEvent({
      ...logFields(opts.log, opts.url),
      outcome: 'ok',
      status: response.status,
      durationMs: Date.now() - startedAt,
      attempt: attempt + 1,
    })

    try {
      return JSON.parse(text) as unknown
    } catch {
      await logAiEvent({
        ...logFields(opts.log, opts.url),
        outcome: 'error',
        status: response.status,
        durationMs: Date.now() - startedAt,
        attempt: attempt + 1,
        detail: 'response was not JSON',
      })
      throw new AiRequestError(
        response.status,
        'The AI service returned a non-JSON response.',
      )
    }
  }
}

/** The identifying fields every log line from one call shares. */
function logFields(
  log: { service: string; model?: string } | undefined,
  url: string,
): { service: string; model: string | undefined; url: string } {
  return { service: log?.service ?? 'ai', model: log?.model, url }
}

/** True for a plain object (not an array or null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow a JSON value to an object, or throw with a readable message. */
export function asRecord(
  value: unknown,
  what: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AiRequestError(
      200,
      `The AI service returned an unexpected ${what}.`,
    )
  }
  return value
}
