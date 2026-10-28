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
 *
 * The third job is static files, and it is not optional. The built server bundle
 * only exports a `fetch` handler; it does not serve `dist/client` itself. Run on
 * its own, every `/assets/*.js` request fell through to the router, came back as
 * the HTML 404 page, and the browser refused to execute it as a module
 * ("disallowed MIME type text/html"). The client found no JavaScript at all.
 */

import entry from '@tanstack/react-start/server-entry'
import type { ServerEntry } from '@tanstack/react-start/server-entry'

import { initDatabase } from '#/db/index.ts'
import { isQuietPath, log, redactPath } from '#/lib/log.ts'

const ready = initDatabase()

/**
 * `dist/client/` sits next to the server bundle, not inside it, so it is resolved
 * relative to this module rather than to the working directory.
 */
const clientRoot = new URL('../client/', import.meta.url)

/**
 * Only build output is reachable: the hashed files under `assets/` plus the files
 * `public/` puts at the root. The character set excludes `.` runs and separators,
 * so no request can climb out of `dist/client`.
 */
const STATIC_PATH = /^\/(?:assets\/[\w-][\w.-]*|drizzle\.svg)$/

/**
 * Answers a request from the client build, or returns null to let it continue to
 * the router. The existence check is what keeps this off in development: `vite
 * dev` serves its own modules, and `dist/` is usually absent.
 */
async function serveStatic(pathname: string): Promise<Response | null> {
  if (!STATIC_PATH.test(pathname)) return null

  const file = Bun.file(new URL(pathname.slice(1), clientRoot))
  if (!(await file.exists())) return null

  // Vite hashes the contents into the filename under `assets/`, so those can be
  // cached forever; the public files have stable names and cannot.
  const immutable = pathname.startsWith('/assets/')

  return new Response(file, {
    headers: {
      'Cache-Control': immutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
    },
  })
}

const serverEntry: ServerEntry = {
  async fetch(...args) {
    const request = args[0]
    const url = new URL(request.url)

    // Before `ready`: an asset does not touch the database, and the page itself
    // cannot render without its JavaScript.
    if (request.method === 'GET' || request.method === 'HEAD') {
      const asset = await serveStatic(url.pathname)
      if (asset) return asset
    }

    await ready

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
