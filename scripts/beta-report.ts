/**
 * The beta funnel, in the terminal.
 *
 * The same numbers `/admin` shows, for when opening the app to read its own
 * metrics is the wrong tool — a server with no browser, a cron job, or a quick
 * look before deciding whether to send more invites.
 *
 *   bun run scripts/beta-report.ts            # print the funnel
 *   bun run scripts/beta-report.ts --prune    # also delete declined requests
 *                                             # older than 90 days
 *
 * Everything here is derived from rows the app writes for its own reasons. No
 * subject, sender, body or third-party address is read, and nothing is sent
 * anywhere.
 */

import { and, eq, lt } from 'drizzle-orm'

import { db, initDatabase } from '../src/db/index.ts'
import {
  accessRequests,
  accounts,
  conversations,
  feedback,
  formResponses,
  forms,
  inviteRedemptions,
  invites,
  productEvents,
  users,
} from '../src/db/schema.ts'

const args = process.argv.slice(2)
const prune = args.includes('--prune')

await initDatabase()

const [requestRows, inviteRows, redemptionRows, userRows, accountRows] =
  await Promise.all([
    db.select().from(accessRequests),
    db.select().from(invites),
    db.select().from(inviteRedemptions),
    db.select().from(users),
    db.select().from(accounts),
  ])

const threadRows = await db
  .select({ accountId: conversations.accountId })
  .from(conversations)

const feedbackRows = await db.select().from(feedback)
const [formRows, formResponseRows] = await Promise.all([
  db.select().from(forms),
  db.select({ formId: formResponses.formId }).from(formResponses),
])
const eventRows = await db
  .select({ userId: productEvents.userId, createdAt: productEvents.createdAt })
  .from(productEvents)

const ownerOf = new Map(
  accountRows
    .filter((row) => Boolean(row.userId))
    .map((row) => [row.id, row.userId as string]),
)

const usersWithMailbox = new Set(ownerOf.values())
const usersWithThreads = new Set(
  threadRows
    .map((row) => ownerOf.get(row.accountId))
    .filter((id): id is string => Boolean(id)),
)

const activeDays = new Map<string, Set<string>>()
for (const event of eventRows) {
  const key = event.createdAt.toISOString().slice(0, 10)
  const set = activeDays.get(event.userId) ?? new Set<string>()
  set.add(key)
  activeDays.set(event.userId, set)
}
const returned = [...activeDays.values()].filter((set) => set.size > 1).length

const approved = requestRows.filter(
  (row) => row.status === 'approved' || row.status === 'redeemed',
).length

const decided = requestRows.filter(
  (row) => row.status !== 'pending',
).length

/** Median of the given durations, or null when there are none. */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const lower = sorted[middle - 1] ?? 0
  const upper = sorted[middle] ?? 0
  return sorted.length % 2 === 0
    ? Math.round((lower + upper) / 2)
    : upper
}

const redeemedByInvite = new Map<string, Date>()
for (const row of redemptionRows) {
  const current = redeemedByInvite.get(row.inviteId)
  if (!current || current > row.redeemedAt) {
    redeemedByInvite.set(row.inviteId, row.redeemedAt)
  }
}

const issuedToRedeemed: number[] = []
for (const invite of inviteRows) {
  const redeemedAt = redeemedByInvite.get(invite.id)
  if (!redeemedAt) continue
  issuedToRedeemed.push(redeemedAt.getTime() - invite.createdAt.getTime())
}

/** A day count is easier to read than a millisecond duration. */
function formatDays(value: number | null): string {
  if (value === null) return '—'
  return `${(value / 86_400_000).toFixed(1)}d`
}

console.log('Nuntia beta')
console.log('')
console.log(`  requests         ${requestRows.length}`)
console.log(
  `  approved         ${approved}` +
    (decided > 0 ? `  (${Math.round((approved / decided) * 100)}% of decided)` : ''),
)
console.log(`  declined         ${requestRows.filter((r) => r.status === 'declined').length}`)
console.log(`  invites issued   ${inviteRows.length}`)
console.log(`  redeemed         ${redemptionRows.length}`)
console.log(`  signed in        ${userRows.length}`)
console.log(`  activated        ${usersWithMailbox.size}  (connected a mailbox)`)
console.log(`  used             ${usersWithThreads.size}  (has a thread)`)
console.log(`  returned         ${returned}  (active on two days)`)
console.log(`  feedback         ${feedbackRows.length}`)
console.log(`  forms on         ${formRows.filter((form) => form.status === 'open').length}`)
console.log(`  form answers     ${formResponseRows.length}`)
console.log('')
console.log(`  median issue → redeem   ${formatDays(median(issuedToRedeemed))}`)

if (userRows.length > 0) {
  console.log('')
  console.log('People')
  const mailboxes = new Map<string, number>()
  for (const row of accountRows) {
    if (!row.userId) continue
    mailboxes.set(row.userId, (mailboxes.get(row.userId) ?? 0) + 1)
  }
  for (const user of [...userRows].sort((a, b) => +a.createdAt - +b.createdAt)) {
    console.log(
      `  ${user.email.padEnd(32)} ${user.role.padEnd(7)} ` +
        `${mailboxes.get(user.id) ?? 0} mailbox(es)`,
    )
  }
}

const pending = requestRows
  .filter((row) => row.status === 'pending')
  .sort((a, b) => +b.createdAt - +a.createdAt)

if (pending.length > 0) {
  console.log('')
  console.log('Waiting')
  for (const row of pending) {
    console.log(`  ${row.email} — ${row.createdAt.toISOString().slice(0, 10)}`)
  }
}

if (prune) {
  const cutoff = new Date(Date.now() - 90 * 86_400_000)
  const removed = await db
    .delete(accessRequests)
    .where(
      and(eq(accessRequests.status, 'declined'), lt(accessRequests.decidedAt, cutoff)),
    )

  console.log('')
  console.log(`Pruned ${removed.rowsAffected} declined request(s) older than 90 days.`)
}

// Codes are not printed: only their hashes exist, and a list of hashes is not
// something an operator can act on.
