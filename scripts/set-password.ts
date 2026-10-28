/**
 * Give an existing account a password.
 *
 * The invite form now collects a password when it creates an account. Accounts
 * created before that carry a hash of random bytes, which no password can match,
 * so once their session cookie is gone there is no form and no email that can
 * get them back in. This script is that way in: the operator, on the machine,
 * is the only party who can prove an address with neither a password nor a
 * mailbox.
 *
 *   bun run scripts/set-password.ts ada@example.com 'a long enough password'
 *
 * Inside the Docker image the same script is bundled next to the server, because
 * the image carries no source:
 *
 *   docker compose exec app bun dist/set-password.js ada@example.com '...'
 *
 * The password is an argument, so it lands in the shell history of whichever
 * machine you type it on. Run it from a shell you do not keep if that matters.
 */

import { initDatabase } from '../src/db/index.ts'
import { setUserPassword } from '../src/lib/auth/users.ts'

const [email, password] = process.argv.slice(2)

if (!email || !password) {
  console.error('usage: bun run scripts/set-password.ts <email> <password>')
  process.exit(1)
}

await initDatabase()

const result = await setUserPassword(email, password)

if ('error' in result) {
  console.error(result.error)
  process.exit(1)
}

console.log(`Password set for ${result.user.email}.`)
