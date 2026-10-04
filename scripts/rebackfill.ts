/**
 * Re-fetch stored threads so a parsing change applies to existing rows.
 *
 * Incremental sync only rewrites threads Gmail reports as changed, so a change to
 * how messages are *parsed* — rather than a new column — cannot be applied by
 * `backfillDerivedFields`, which reads from the local messages table where the
 * data never existed.
 *
 * The threads are re-fetched by id, not by search query, and that distinction is
 * the whole design. A `newer_than:30d` query returns whatever is still inside
 * the window: on this mailbox that is 6 threads out of 31, because mail ages out
 * of a date range whether or not the app still shows it. Ids come from the
 * database, so every conversation already in the inbox gets fixed and nothing
 * else is pulled in.
 *
 *   bun run scripts/rebackfill.ts <account-email>            # every thread
 *   bun run scripts/rebackfill.ts <account-email> --missing-html
 *
 * `--missing-html` limits the work to threads whose messages have no stored
 * HTML, which is what a rendering fix needs.
 *
 * Requires a stored, still-valid refresh token. Messages are rewritten wholesale
 * per thread, so this never touches accounts or auth.
 */

import { createGmailApiClient } from '../src/lib/gmail/client.ts'
import { createGmailClient } from '../src/lib/auth/google.ts'
import { getAccountEnvelope } from '../src/lib/auth/accounts.ts'
import { getStoredThreadIds } from '../src/lib/conversation/repository.ts'
import { syncThread } from '../src/lib/gmail/sync.ts'
import { initDatabase } from '../src/db/index.ts'

const [accountId, flag] = process.argv.slice(2)

if (!accountId) {
  console.error(
    'Usage: bun run scripts/rebackfill.ts <account-email> [--missing-html]',
  )
  process.exit(1)
}

await initDatabase()

const envelope = await getAccountEnvelope(accountId)
if (!envelope) {
  console.error(`No stored Google account for ${accountId}.`)
  process.exit(1)
}

const client = createGmailApiClient(await createGmailClient(envelope), accountId)

const onlyMissingHtml = flag === '--missing-html'
const threadIds = await getStoredThreadIds(accountId, { onlyMissingHtml })

console.log(
  `Re-fetching ${threadIds.length} thread(s) for ${accountId}${onlyMissingHtml ? ' (missing HTML only)' : ''}…`,
)

if (threadIds.length === 0) {
  console.log('Nothing to do.')
  process.exit(0)
}

// Sequential rather than concurrent: this is a maintenance script run by hand,
// and a single background job against the API is easier to reason about than a
// burst that risks the per-user rate limit.
let synced = 0
let skipped = 0

for (const id of threadIds) {
  try {
    const thread = await client.getThread(id)
    const outcome = await syncThread(accountId, thread)

    if (outcome === 'synced') {
      synced++
      console.log(`  ok    ${id}`)
    } else {
      skipped++
      console.log(`  skip  ${id} (${outcome})`)
    }
  } catch (error) {
    skipped++
    console.log(
      `  FAIL  ${id}: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }
}

console.log(`Done: ${synced} synced, ${skipped} skipped.`)