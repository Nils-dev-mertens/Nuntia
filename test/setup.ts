/**
 * Test preload.
 *
 * Loaded via `bunfig.toml` before *any* test module, so it runs before
 * `#/db/index.ts` can read `DATABASE_URL` and bind a client.
 *
 * This exists because isolation used to depend on `sync.test.ts` happening to be
 * the first file to import the database module. That is not a property you can
 * rely on: adding any test file with a static import of the conversation layer
 * reorders the graph, and the whole suite silently starts writing to the real
 * mailbox database. It did exactly that — sync's `delete` statements wiped a
 * real synced account.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A fresh file per run, never the checked-out `data/lumen.db`.
const dir = mkdtempSync(join(tmpdir(), 'nuntia-test-'))

process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`

// Read by `#/db/index.ts` as a hard stop if anything still resolves the real
// database. See the guard there.
process.env.LUMEN_TEST = '1'

// The app defaults to the invite beta, which closes password registration. Most
// suites exercise the password flow, so they get login mode explicitly; the
// suites that test the gate set `LUMEN_ACCESS_MODE=invite` themselves. Pinning
// it here also means a developer's `.env.local` cannot change what tests see.
process.env.LUMEN_ACCESS_MODE = 'login'