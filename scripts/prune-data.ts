/**
 * Delete derived records that are kept only for a while.
 *
 * Two tables grow without any bound and hold personal data as a by-product of
 * the app's own work:
 *
 * - `decisions` — one row per (re-)classification, including the model's
 *   reasoning, which can quote the mail it read.
 * - `contact_tag_events` — one row per tag membership change, including
 *   auto-applied ones.
 *
 * Neither is needed forever: `decisions` is an audit trail for classification
 * quality, and the tag events beyond the last few are history. Keeping both
 * forever means a mailbox's whole reading history sits in the database next to
 * the mail, which is exactly the kind of second copy data protection is about.
 *
 *   bun run scripts/prune-data.ts                 # default: older than 365 days
 *   bun run scripts/prune-data.ts --days 180
 *   bun run scripts/prune-data.ts --dry-run       # count only
 *
 * With `secure_delete` on (`src/db/index.ts`) the freed pages are overwritten,
 * so there is nothing left to read in the file afterwards.
 *
 * Schedule it like the backup, not from memory:
 *
 *   40 3 * * 0 cd /srv/nuntia && bun run scripts/prune-data.ts --days 365 >> /var/log/nuntia-prune.log 2>&1
 *
 * The tag-event default is deliberately long: a short window could drop the
 * event that makes an automatically written tag description look stale, and the
 * app would then never re-draft it.
 */

import { lt } from 'drizzle-orm'

import { client, db, initDatabase } from '../src/db/index.ts'
import { contactTagEvents, decisions } from '../src/db/schema.ts'

const args = process.argv.slice(2)

function flag(name: string): string | null {
  const index = args.indexOf(name)
  return index === -1 ? null : (args[index + 1] ?? null)
}

const days = (() => {
  const raw = Number(flag('--days') ?? 365)
  return Number.isInteger(raw) && raw > 0 ? raw : 365
})()

const dryRun = args.includes('--dry-run')
const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

await initDatabase()

async function count(sql: string, value: number): Promise<number> {
  const result = await client.execute({ sql, args: [value] })
  return Number(result.rows[0]?.n ?? 0)
}

const staleDecisions = await count(
  'SELECT count(*) AS n FROM decisions WHERE decided_at < ?',
  cutoff.getTime(),
)
const staleEvents = await count(
  'SELECT count(*) AS n FROM contact_tag_events WHERE created_at < ?',
  cutoff.getTime(),
)

console.log(
  `older than ${days} day(s) (before ${cutoff.toISOString()}): ` +
    `${staleDecisions} decision(s), ${staleEvents} tag event(s)`,
)

if (dryRun) {
  console.log('dry run: nothing deleted')
  process.exit(0)
}

// The drizzle forms rather than raw SQL so the column types stay the source of
// truth for the comparison (both are `timestamp_ms` integers).
const deletedDecisions = await db
  .delete(decisions)
  .where(lt(decisions.decidedAt, cutoff))
  .returning({ id: decisions.id })

const deletedEvents = await db
  .delete(contactTagEvents)
  .where(lt(contactTagEvents.createdAt, cutoff))
  .returning({ id: contactTagEvents.id })

console.log(
  `deleted ${deletedDecisions.length} decision(s) and ${deletedEvents.length} tag event(s)`,
)

client.close()
