/**
 * Application logging.
 *
 * One JSON line per event, appended to `data/logs/app.log` (`APP_LOG_DIR` moves
 * it), rotated once past the size limit with a single previous file kept. A line
 * per event stays greppable, a file is still there tomorrow, and the format is
 * stable enough for `jq`.
 *
 * What is deliberately *not* logged:
 *
 * - Invite codes. `/join/<code>` is a credential, so the path is collapsed to
 *   `/join/[code]` and query strings are dropped entirely — they can carry a
 *   code, an email, or a thread id.
 * - Mail content. Nothing here reads a subject, a body, or a participant; the
 *   conversation pipeline has its own (AI) log for what it calls.
 * - Tokens and keys. Only counts, statuses, durations and paths.
 *
 * Writing happens after the response is produced, through a promise chain, so a
 * slow disk never adds latency to a request. A failed write is warned about once
 * and then swallowed: logging must not be able to break the thing it describes.
 */

import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Rotate above this; one previous file is kept. */
const MAX_LOG_BYTES = 2_000_000

export type LogLevel = 'info' | 'warn' | 'error'

export type LogFields = Record<string, string | number | boolean | null | undefined>

/** Directory the app log lives in. */
export function appLogDir(): string {
  return process.env.APP_LOG_DIR ?? resolve(process.cwd(), 'data/logs')
}

/** File log lines are appended to. */
export function appLogPath(): string {
  return join(appLogDir(), 'app.log')
}

/**
 * Reduce a request path to something safe to keep.
 *
 * The invite code is the whole credential, so it must not appear in a file that
 * outlives the invite — and the query string is dropped rather than filtered,
 * because the next route to put something sensitive in one will not remember
 * this comment.
 */
export function redactPath(pathname: string): string {
  const path = pathname.split('?')[0] ?? pathname

  if (path === '/join' || path.startsWith('/join/')) {
    return path === '/join' ? path : '/join/[code]'
  }

  // Auth callbacks carry `code` and `state` in the query; the path alone is
  // enough to see that the flow was reached.
  return path
}

/** Requests that are noise: assets, dev-tooling internals, the favicon. */
export function isQuietPath(pathname: string): boolean {
  return (
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/@') ||
    pathname.startsWith('/_build/') ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt'
  )
}

let writeChain: Promise<void> = Promise.resolve()
let warnedAboutLog = false

async function append(line: string): Promise<void> {
  // Tests drive the app without a dev server; writing there would mix fake
  // traffic into the real log. `APP_LOG_DIR` opts a test back in.
  if (process.env.LUMEN_TEST === '1' && !process.env.APP_LOG_DIR) return

  const path = appLogPath()

  try {
    await mkdir(appLogDir(), { recursive: true })

    const size = await stat(path).then((info) => info.size).catch(() => 0)
    if (size > MAX_LOG_BYTES) {
      await rm(`${path}.1`, { force: true }).catch(() => {})
      await rename(path, `${path}.1`).catch(() => {})
    }

    await appendFile(path, `${line}\n`, 'utf8')
  } catch (error) {
    if (warnedAboutLog) return
    warnedAboutLog = true
    console.warn('[log] could not write the app log:', error)
  }
}

/**
 * Record one event. Returns immediately; the write is queued.
 *
 * Warnings and errors also reach the console, so a foreground `bun run dev` or a
 * container's stdout shows them without tailing the file.
 */
export function log(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void {
  const record = {
    at: new Date().toISOString(),
    level,
    event,
    ...fields,
  }

  if (level !== 'info') {
    // One line keeps it readable in a terminal; the file keeps the full record.
    const detail =
      typeof fields.message === 'string' ? fields.message : JSON.stringify(fields)
    const sink = level === 'error' ? console.error : console.warn
    sink(`[${event}] ${detail}`)
  }

  let line: string
  try {
    line = JSON.stringify(record)
  } catch {
    // A field with a cycle would otherwise throw from the logger itself.
    line = JSON.stringify({ at: record.at, level, event, unserialisable: true })
  }

  writeChain = writeChain.then(() => append(line))
}

/** Flush pending writes. For scripts that exit immediately after logging. */
export function flushLog(): Promise<void> {
  return writeChain
}
