/**
 * Set an account's password — creating the account if it does not exist yet.
 *
 * The invite form collects a password when it creates an account. Accounts made
 * before that carry a hash of random bytes, which no password can match, so once
 * their session cookie is gone there is no form and no email that can get them
 * back in. And an install with no user at all has nothing to sign in as, which
 * also means nobody can issue an invite. This script is the way out of both: the
 * operator, on the machine, is the only party who can prove an address with
 * neither a password nor a mailbox.
 *
 *   bun run scripts/set-password.ts ada@example.com 'a long enough password'
 *   bun run scripts/set-password.ts ada@example.com '...' --admin
 *
 * `--admin` makes that account an operator, so it can open `/admin`. Without it
 * the account is a member — except when it is the first user on the install,
 * which is an admin by rule.
 *
 * Inside the Docker image the same script is bundled next to the server, because
 * the image carries no source:
 *
 *   docker compose exec app bun dist/set-password.js ada@example.com '...' --admin
 *
 * The password is an argument, so it lands in the shell history of whichever
 * machine you type it on. Run it from a shell you do not keep if that matters.
 */

import { initDatabase } from '../src/db/index.ts'
import { setUserPassword } from '../src/lib/auth/users.ts'

const args = process.argv.slice(2)
const admin = args.includes('--admin')
const [email, password] = args.filter((arg) => arg !== '--admin')

if (!email || !password) {
  console.error(
    'usage: bun run scripts/set-password.ts <email> <password> [--admin]',
  )
  process.exit(1)
}

await initDatabase()

const result = await setUserPassword(email, password, { admin })

if ('error' in result) {
  console.error(result.error)
  process.exit(1)
}

const verb = result.created ? 'Created' : 'Password set for'
console.log(`${verb} ${result.user.email}.`)
