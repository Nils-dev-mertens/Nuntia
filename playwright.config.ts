/**
 * End-to-end harness for the Actions test job (issue #1).
 *
 * The suite drives the real server rather than a mock: a fresh SQLite file, the
 * beta's access mode, and the bootstrap code that creates the first account.
 * That is the only way to check the funnel a stranger actually walks through —
 * request, invite, sign-in — because each step is a cookie and a redirect.
 *
 * One worker on purpose. The app writes to a single database file, and the
 * first account can only be created once, so the tests are a sequence rather
 * than independent cases.
 *
 * `bun run test:e2e` runs it; `PLAYWRIGHT_CHANNEL=chrome bun run test:e2e` uses
 * an already-installed Chrome instead of the downloaded Chromium.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineConfig, devices } from '@playwright/test'

const PORT = 3100
const BASE_URL = `http://localhost:${PORT}`

/**
 * A database created fresh for this run.
 *
 * Deleting the previous one is not reliable — on Windows a file the journal or
 * a file-sync client still holds cannot be removed — and `LUMEN_BOOTSTRAP_INVITE`
 * only works while no user exists. A new path per run gives every run an empty
 * install without touching whatever is already there.
 */
const E2E_DB = join(mkdtempSync(join(tmpdir(), 'nuntia-e2e-')), 'e2e.db')

export default defineConfig({
  testDir: './e2e',
  // `.e2e.ts` rather than `.spec.ts`: `bun test` treats a `spec` file as one of
  // its own and would try to run these under the unit runner.
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // CI installs the bundled Chromium and leaves this unset. Locally, a
        // machine that already has Chrome can point at it with
        // `PLAYWRIGHT_CHANNEL=chrome` instead of downloading a second browser.
        channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
      },
    },
  ],
  /**
   * `reuseExistingServer: false` always: a server left over from another run
   * would keep the previous database, and the tests would fail on the second run
   * for a reason that has nothing to do with the code.
   */
  webServer: {
    command: `bunx vite dev --port ${PORT} --strictPort`,
    url: `${BASE_URL}/sign-in`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: `file:${E2E_DB}`,
      // Any 32-byte hex value: the harness has no real secrets to protect.
      TOKEN_ENCRYPTION_KEY: '0'.repeat(64),
      LUMEN_ACCESS_MODE: 'invite',
      LUMEN_APP_URL: BASE_URL,
      // The way in on an empty install. Honoured only while no user exists.
      LUMEN_BOOTSTRAP_INVITE: 'AAAA-BBBB-CCCC',
      // Set to empty rather than left out: a `.env.local` that configures a
      // default account would create the first user on the first request and
      // close the empty-install window this suite depends on. Both bootstraps
      // check for a value, so an empty string switches them off.
      LUMEN_DEFAULT_USER_EMAIL: '',
      LUMEN_DEFAULT_USER_PASSWORD: '',
    },
  },
})
