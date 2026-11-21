/**
 * Erase one user and everything the app holds about them.
 *
 * The procedure lives in `src/lib/auth/erasure.ts`; this is the operator half:
 * show what would go, refuse to act without `--yes`, then show what went.
 *
 *   bun run scripts/delete-user.ts someone@example.com
 *   bun run scripts/delete-user.ts someone@example.com --yes
 *
 * Run it with the service stopped. It is a delete, not a flag: there is no undo,
 * and the copies it cannot reach are listed at the end.
 */

import { eraseUser, planUserErasure } from '../src/lib/auth/erasure.ts'
import { initDatabase } from '../src/db/index.ts'

const target = process.argv[2]
const confirmed = process.argv.includes('--yes')

if (!target || target.startsWith('-')) {
  console.error(
    'usage: bun run scripts/delete-user.ts <email> [--yes]\n' +
      '  Without --yes it only reports what would be deleted.',
  )
  process.exit(2)
}

await initDatabase()

const plan = await planUserErasure(target)

if (!plan.user) {
  console.error(`No user "${plan.userId}" in this database.`)
  process.exit(1)
}

console.log(`user: ${plan.user.email}${plan.user.name ? ` (${plan.user.name})` : ''}`)

const populated = plan.tables.filter((entry) => entry.rows > 0)
if (populated.length > 0) {
  console.log('rows that will be deleted:')
  for (const entry of populated) {
    console.log(`  ${entry.table}.${entry.column}: ${entry.rows}`)
  }
}

console.log(
  `mail from ${plan.mail.accounts} connected mailbox(es): ` +
    `${plan.mail.conversations} conversation(s), ${plan.mail.messages} message(s), ` +
    `${plan.mail.attachments} attachment(s), ${plan.mail.decisions} decision(s)`,
)

if (plan.retained.invites > 0 || plan.retained.accessRequests > 0) {
  console.log(
    'kept (records about the address, not owned by it): ' +
      `${plan.retained.invites} invite(s), ` +
      `${plan.retained.accessRequests} access request(s)`,
  )
}

if (!confirmed) {
  console.log('\nnothing was deleted. Re-run with --yes to erase this user.')
  process.exit(1)
}

const report = await eraseUser(plan.userId)

console.log(
  `\nerased ${report.userId}: ${report.deleted.rows} row(s) across ` +
    `${report.deleted.tables} table(s), plus ` +
    `${report.deleted.mail.conversations} conversation(s) and ` +
    `${report.deleted.mail.messages} message(s).`,
)
console.log(
  'Copies this script cannot reach still exist and must be aged out: ' +
    'backups in BACKUP_DIR (BACKUP_KEEP rotations), and anything already ' +
    'copied off the host.',
)
