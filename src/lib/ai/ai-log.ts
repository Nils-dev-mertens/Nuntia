/**
 * The AI log.
 *
 * Both AI services are bring-your-own-key calls to a paid API, and until now the
 * only trace of a failure was a `console.error` in whichever terminal happened to
 * be running the app: gone as soon as it scrolls, and absent entirely in a built
 * app with no attached console. "The AI does nothing" then leaves nothing to look
 * at, which is the state this module exists to fix.
 *
 * One JSON line per event, appended to `data/logs/ai.log` (`AI_LOG_DIR` moves it),
 * because a line per event stays greppable and a file is still there tomorrow.
 * Rotated once past `MAX_LOG_BYTES`, keeping a single previous file, so a busy
 * install cannot fill the disk with its own history.
 *
 * What is deliberately *not* recorded: the API key, the request body, and the
 * prompt. The last two are the user's mail, and none of the three belongs in a
 * log. A failure records the service's own error text, truncated — that is the
 * part that says what was wrong.
 *
 * Failure to write is swallowed after one warning: a log that can break the call
 * it describes is worse than no log.
 */

import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Rotate at this size; one previous file is kept. */
const MAX_LOG_BYTES = 1_000_000

/** How much of a service's error text is kept. */
const MAX_DETAIL_CHARS = 300

export type AiLogOutcome = 'ok' | 'retry' | 'error'

/** An event as it is written: the caller's fields plus the timestamp added here. */
export type AiLogRecord = AiLogEntry & { at: string }

export type AiLogEntry = {
  /** Which service: `jev`, `llm:openai`. */
  service: string
  outcome: AiLogOutcome
  /** HTTP status; 0 when the request never reached the service. */
  status?: number
  /** How long the attempt took. */
  durationMs?: number
  /** 1 for the first attempt, so a retry is distinguishable from a failure. */
  attempt?: number
  /** Model id the call asked for. */
  model?: string
  /** Endpoint, so a wrong URL is visible rather than guessed at. */
  url?: string
  /** Short reason: the service's error text, or a shape complaint. */
  detail?: string
}

/** Directory the log lives in. */
export function aiLogDir(): string {
  return process.env.AI_LOG_DIR ?? resolve(process.cwd(), 'data/logs')
}

/** File the log is appended to. */
export function aiLogPath(): string {
  return join(aiLogDir(), 'ai.log')
}

let warnedAboutLog = false

/**
 * Append one event.
 *
 * Skipped while running the test suite: the AI clients are driven with fake
 * fetches there, and mixing those into the real log would corrupt the very
 * history someone would read to explain the app's own behaviour. Point
 * `AI_LOG_DIR` at a temp directory to exercise this module from a test.
 */
export async function logAiEvent(entry: AiLogEntry): Promise<void> {
  if (process.env.LUMEN_TEST === '1' && !process.env.AI_LOG_DIR) return

  const record: AiLogRecord = {
    ...entry,
    at: new Date().toISOString(),
    detail: entry.detail?.slice(0, MAX_DETAIL_CHARS),
  }
  const line = `${JSON.stringify(record)}\n`

  try {
    await mkdir(aiLogDir(), { recursive: true })
    await rotateIfLarge()
    await appendFile(aiLogPath(), line, 'utf-8')
  } catch (error) {
    if (warnedAboutLog) return
    warnedAboutLog = true
    console.warn('[ai] could not write the AI log:', error)
  }
}

/** Move the current file aside once it has grown past the cap. */
async function rotateIfLarge(): Promise<void> {
  const info = await stat(aiLogPath()).catch(() => null)
  if (!info || info.size < MAX_LOG_BYTES) return

  const previous = `${aiLogPath()}.1`
  // Removed first: `rename` onto an existing path fails on Windows.
  await rm(previous, { force: true })
  await rename(aiLogPath(), previous)
}

/**
 * The most recent events, oldest first — what the settings screen shows.
 *
 * A malformed line is skipped rather than thrown on: a log that a half-written
 * line can make unreadable is not a log anyone can rely on. Missing file is not
 * an error either; it just means nothing has been logged yet.
 */
export async function readRecentAiEvents(limit = 20): Promise<AiLogRecord[]> {
  const text = await readFile(aiLogPath(), 'utf-8').catch(() => '')

  const lines = text.split('\n').filter((line) => line.trim())

  return lines.slice(-limit).flatMap((line) => {
    try {
      return [JSON.parse(line) as AiLogRecord]
    } catch {
      return []
    }
  })
}

/** Read a caught error's HTTP status, if the thrower recorded one. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

/** Render any thrown value as a single line. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Record a failure the *caller* caught, and keep it in the terminal too.
 *
 * The HTTP layer logs every attempt it makes. This is for the failures it cannot
 * see: a 200 whose body did not have the shape the service promised, an empty
 * completion, a generator that returned nothing. From the outside those look like
 * "the AI did nothing", and without this they leave no trace at all.
 */
export async function reportAiFailure(
  service: string,
  error: unknown,
  what = 'failed',
): Promise<void> {
  const detail = messageOf(error)
  console.error(`[ai] ${service} ${what}: ${detail}`)

  await logAiEvent({
    service,
    outcome: 'error',
    status: statusOf(error),
    detail,
  })
}
