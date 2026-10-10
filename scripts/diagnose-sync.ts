/**
 * Inspect why the inbox is not showing new mail.
 *
 * Incremental sync only ever replays changes *after* the stored history cursor,
 * and the cursor advances even when saving a thread fails. So the signature of
 * "an email arrived but never appeared" is: the cursor is ahead of the newest
 * conversation in the database. This prints exactly that comparison, plus the
 * configuration that would make a sync fail, so the cause is visible instead of
 * guessed at.
 *
 *   bun run scripts/diagnose-sync.ts                    # report only
 *   bun run scripts/diagnose-sync.ts --reset-cursor     # clear the cursor
 *   bun run scripts/diagnose-sync.ts --backfill         # rebuild from Gmail now
 *   bun run scripts/diagnose-sync.ts --backfill --limit=25  # just the newest 25
 *   bun run scripts/diagnose-sync.ts me@example.com ... # one account only
 *
 * `--limit` bounds the backfill. `threads.list` is newest-first, so a small
 * value is enough to recover recent mail without paying for a whole mailbox; a
 * full rebuild is what the app's "Re-sync" button does.
 *
 * `--reset-cursor` only touches sync state (the cursor row and the account's
 * `history_id`); it never deletes conversations, messages, or auth tokens.
 * `--backfill` is the same full sync the app's "Re-sync" button runs, with
 * per-thread progress logged so a failing thread names itself.
 */

import { desc, eq, sql } from 'drizzle-orm'

import { db, initDatabase } from '../src/db/index.ts'
import { accounts, conversations, decisions, historyCursors } from '../src/db/schema.ts'
import { getAccountEnvelope } from '../src/lib/auth/accounts.ts'
import { createGmailClient } from '../src/lib/auth/google.ts'
import { createGmailApiClient } from '../src/lib/gmail/client.ts'
import { BACKFILL_QUERY } from '../src/lib/gmail/service.ts'
import { backfill } from '../src/lib/gmail/sync.ts'

const args = process.argv.slice(2)
const resetCursor = args.includes('--reset-cursor')
const runBackfill = args.includes('--backfill')
const accountArg = args.find((arg) => !arg.startsWith('--'))
const limitFlag = args.find((arg) => arg.startsWith('--limit='))
const limit = limitFlag ? Number(limitFlag.slice('--limit='.length)) : undefined
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  console.error('--limit must be a positive integer, e.g. --limit=25')
  process.exit(1)
}

await initDatabase()

console.log(`Database: ${process.env.DATABASE_URL ?? 'file:./data/lumen.db'}`)

const allAccounts = await db.query.accounts.findMany()
if (allAccounts.length === 0) {
  console.log('\nNo connected accounts.')
  process.exit(0)
}

const wanted = accountArg?.toLowerCase()
const targets = wanted
  ? allAccounts.filter(
      (account) => account.id === wanted || account.email === wanted,
    )
  : allAccounts

if (targets.length === 0) {
  console.error(`\nNo connected account matches "${accountArg}".`)
  process.exit(1)
}

console.log(`\nAccounts (${targets.length} of ${allAccounts.length}):`)
for (const account of targets) {
  console.log(`  ${account.email}`)
  console.log(
    `    cursor=${account.historyId ?? '(none — the next sync will backfill)'}` +
      `  derivedVersion=${account.derivedVersion}` +
      `  cursorUpdatedAt=${account.updatedAt.toISOString()}`,
  )
}

const [{ count: conversationCount }] = await db
  .select({ count: sql<number>`count(*)` })
  .from(conversations)

console.log(`\nConversations: ${conversationCount}`)

const byState = await db
  .select({ state: conversations.state, count: sql<number>`count(*)` })
  .from(conversations)
  .groupBy(conversations.state)
for (const row of byState) {
  console.log(`  ${row.state}: ${row.count}`)
}

const newest = await db.query.conversations.findMany({
  orderBy: [desc(conversations.lastMessageAt)],
  limit: 8,
})
console.log('\nNewest conversations:')
for (const conversation of newest) {
  console.log(
    `  ${conversation.lastMessageAt.toISOString()}  ` +
      `${conversation.state.padEnd(18)} ${conversation.subject}`,
  )
}

const settings = await db.query.appSettings.findFirst()
console.log('\nAI settings (the layer whose failure aborts a save):')
console.log(
  `  topic LLM: ${
    settings?.llmProvider
      ? `${settings.llmProvider} / ${settings.llmModel ?? '(provider default)'}`
      : 'not configured'
  } (key ${settings?.llmApiKeyEncrypted ? 'stored' : 'missing'})`,
)
console.log(
  `  decision model: ${
    settings?.jevApiKeyEncrypted
      ? `configured (${settings.jevModel ?? 'default'})`
      : 'not configured'
  }`,
)

const recentDecisions = await db.query.decisions.findMany({
  orderBy: [desc(decisions.decidedAt)],
  limit: 5,
})
console.log(`\nRecent decision rows: ${recentDecisions.length}`)
for (const decision of recentDecisions) {
  console.log(
    `  ${decision.decidedAt.toISOString()}  ${decision.provider}  ` +
      `${decision.state}  topic=${decision.topic ?? '(none)'}`,
  )
}

if (resetCursor) {
  console.log('\nClearing stored history cursor(s):')
  for (const account of targets) {
    await db
      .update(accounts)
      .set({ historyId: null })
      .where(eq(accounts.id, account.id))
    await db
      .delete(historyCursors)
      .where(eq(historyCursors.accountId, account.id))
    console.log(`  cleared ${account.email}`)
  }
  console.log(
    'The next sync (app load, the "Re-sync" button, or --backfill) will rebuild from threads.list.',
  )
}

if (runBackfill) {
  console.log(
    `\nRunning a full backfill (query: ${BACKFILL_QUERY}${
      limit ? `, limit ${limit}` : ''
    }):`,
  )
  for (const account of targets) {
    const envelope = await getAccountEnvelope(account.id)
    if (!envelope) {
      console.log(`  ${account.email}: no stored Google token, skipping.`)
      continue
    }

    const client = createGmailApiClient(
      await createGmailClient(envelope),
      account.id,
    )

    try {
      const result = await backfill(client, account.id, {
        query: BACKFILL_QUERY,
        limit,
        onProgress: (event) => {
          switch (event.type) {
            case 'start':
              console.log(`  ${account.email}: listing threads…`)
              break
            case 'error':
              // The whole reason this script exists: a thread that failed to
              // persist names itself here.
              console.log(`  FAIL ${event.threadId}: ${event.message}`)
              break
            case 'done':
              console.log(
                `  ${account.email}: ${event.synced} synced, ${event.skipped} skipped`,
              )
              break
            default:
              break
          }
        },
      })
      console.log(
        `  ${account.email}: done, cursor now ${result.historyId} (${result.estimated} listed)`,
      )
    } catch (error) {
      console.log(
        `  ${account.email}: backfill failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      )
    }
  }
}
