/**
 * Back up the database.
 *
 * `VACUUM INTO` rather than a file copy: it writes a consistent snapshot
 * including whatever is still in the WAL, so the copy opens without a `-wal`
 * sidecar and without the torn-page risk of copying a live file. The result is
 * checked with `PRAGMA quick_check` before being accepted.
 *
 *   bun run scripts/backup-db.ts
 *   BACKUP_DIR=/var/backups/nuntia BACKUP_KEEP=30 bun run scripts/backup-db.ts
 *
 * Retention keeps the newest `BACKUP_KEEP` files (default 14) and deletes the
 * rest. Names sort chronologically, which is what the cleanup relies on.
 *
 * Schedule it, do not remember it. On a Linux box:
 *
 *   17 3 * * * cd /srv/nuntia && BACKUP_KEEP=30 bun run scripts/backup-db.ts >> /var/log/nuntia-backup.log 2>&1
 *
 * On Windows, a Task Scheduler job running the same command. Either way the
 * backup directory should be on a different disk from `data/` — a backup beside
 * the database survives a bad migration, not a dead machine.
 */

import { mkdir, readdir, rm, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { createClient } from '@libsql/client'

import { client, initDatabase } from '../src/db/index.ts'

const BACKUP_PREFIX = 'nuntia-'

const dir = process.env.BACKUP_DIR
  ? resolve(process.env.BACKUP_DIR)
  : resolve(process.cwd(), 'data/backups')

const keep = (() => {
  const raw = Number(process.env.BACKUP_KEEP ?? 14)
  return Number.isInteger(raw) && raw > 0 ? raw : 14
})()

await initDatabase()
await mkdir(dir, { recursive: true })

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const target = join(dir, `${BACKUP_PREFIX}${stamp}.db`)

// libSQL takes the path inside SQL, so quote it and let the engine see forward
// slashes on every platform.
const sqlPath = target.replace(/\\/g, '/').replace(/'/g, "''")
await client.execute(`VACUUM INTO '${sqlPath}'`)

// A backup nobody opened is a guess. `quick_check` reads the new file from
// scratch, which catches a truncated write before it is counted as one of the
// copies worth keeping.
const copy = createClient({ url: `file:${sqlPath}` })
try {
  const check = await copy.execute('PRAGMA quick_check')
  const verdict = check.rows[0]?.quick_check
  if (verdict !== 'ok') {
    await unlink(target).catch(() => {})
    console.error(`backup failed integrity check (${String(verdict)}): ${target}`)
    process.exit(1)
  }
} finally {
  copy.close()
}

const size = await stat(target).then((info) => info.size)
console.log(`backup: ${target} (${Math.round(size / 1024)} KiB)`)

// Oldest first by name: the ISO timestamp is the sort key, and the prefix is
// fixed, so no parsing is needed.
const existing = (await readdir(dir))
  .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith('.db'))
  .sort()

const stale = existing.slice(0, Math.max(0, existing.length - keep))
for (const name of stale) {
  await rm(join(dir, name), { force: true })
}
if (stale.length > 0) {
  console.log(`pruned ${stale.length} old backup(s), keeping ${keep}`)
}
