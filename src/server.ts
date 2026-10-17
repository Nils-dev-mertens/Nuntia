/**
 * Server entry.
 *
 * Exists for one reason: the SQLite pragmas `initDatabase` sets are *connection*
 * settings, so only the process that serves requests can apply them. Nothing did
 * — its doc claimed it ran at import, while in practice only the tests and the
 * scripts called it. So the app ran on SQLite's defaults: a rollback journal, and
 * no busy timeout. WAL is what lets a reader and a sync writer proceed together,
 * and without a timeout a contended writer fails immediately, which drops that
 * thread's mail.
 *
 * The framework's own default entry does the real work; this wraps it so the
 * pragmas are applied before the first request. Awaited once per process, since
 * `initDatabase` returns a single promise — a request after the first pays
 * nothing.
 */

import entry from '@tanstack/react-start/server-entry'
import type { ServerEntry } from '@tanstack/react-start/server-entry'

import { initDatabase } from '#/db/index.ts'

const ready = initDatabase()

const serverEntry: ServerEntry = {
  async fetch(...args) {
    await ready
    return entry.fetch(...args)
  },
}

export default serverEntry
