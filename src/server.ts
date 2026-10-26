/**
 * Server entry.
 *
 * Two jobs. The first is the reason this file exists: the SQLite pragmas
 * `initDatabase` sets are *connection* settings, so only the process that serves
 * requests can apply them. Nothing did — its doc claimed it ran at import, while
 * in practice only the tests and the scripts called it. So the app ran on
 * SQLite's defaults: a rollback journal, and no busy timeout. WAL is what lets a
 * reader and a sync writer proceed together, and without a timeout a contended
 * writer fails immediately, which drops that thread's mail.
 *
 * The second is request logging. One line per request in `data/logs/app.log`,
 * with the invite code redacted and query strings dropped — see `lib/log.ts` for
 * what is deliberately not recorded. Assets and dev-tooling requests are skipped
 * so the file stays readable; failures are logged with the message and rethrown
 * unchanged, because this wrapper is not allowed to change a response.
 *
 * Logging happens after the response exists, through a queued write, so it adds
 * no latency to the request it describes.
 */

import entry from '@tanstack/react-start/server-entry'
import type { ServerEntry } from '@tanstack/react-start/server-entry'

import { initDatabase } from '#/db/index.ts'
import { isQuietPath, log, redactPath } from '#/lib/log.ts'

const ready = initDatabase()

const serverEntry: ServerEntry = {
  async fetch(...args) {
    await ready

    const request = args[0]
    const url = new URL(request.url)
    const started = performance.now()
    const quiet = isQuietPath(url.pathname)

    try {
      const response = await entry.fetch(...args)

      if (!quiet) {
        log('info', 'request', {
          method: request.method,
          path: redactPath(url.pathname),
          status: response.status,
          ms: Math.round(performance.now() - started),
        })
      }

      return response
    } catch (error) {
      // A thrown handler is a 500 the framework turns into a response later;
      // recording it here is the only place that sees the original error, and
      // the client only ever gets a generic page.
      log('error', 'request-failed', {
        method: request.method,
        path: redactPath(url.pathname),
        ms: Math.round(performance.now() - started),
        message: error instanceof Error ? error.message : 'unknown error',
      })

      throw error
    }
  },
}

export default serverEntry
