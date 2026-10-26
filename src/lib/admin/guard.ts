/**
 * Who may open `/admin`.
 *
 * Two ways in, deliberately different in nature: the `admin` role on the user
 * row, and `LUMEN_ADMIN_EMAILS` from the environment. The column is how the
 * first invited user becomes an operator without a restart; the env list is the
 * break-glass path for a bad migration, a deleted row, or an install whose only
 * admin cannot sign in.
 *
 * The check is a server function's own job, not the route loader's. A loader
 * gate protects the page; a server function is a separate endpoint with a nicer
 * syntax, and anything it returns is reachable without visiting the page at all.
 */

import { eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { users } from '#/db/schema.ts'
import { getSession } from '#/lib/auth/index.ts'

export type Operator = {
  userId: string
  /** How they qualified — useful in a log, never in the UI. */
  via: 'role' | 'env'
}

/** True when this address is named in `LUMEN_ADMIN_EMAILS`. */
export function isOperatorEmail(email: string): boolean {
  const list = process.env.LUMEN_ADMIN_EMAILS
  if (!list) return false

  const wanted = email.trim().toLowerCase()
  if (!wanted) return false

  return list
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(wanted)
}

/** Whether this address may operate the install, signed in or not. */
export async function isOperatorUser(email: string): Promise<boolean> {
  if (isOperatorEmail(email)) return true

  const row = await db.query.users.findFirst({
    where: eq(users.id, email.trim().toLowerCase()),
  })

  return row?.role === 'admin'
}

/** The signed-in operator, or null. Never throws. */
export async function currentOperator(): Promise<Operator | null> {
  const session = await getSession()
  if (!session) return null

  if (isOperatorEmail(session.userId)) {
    return { userId: session.userId, via: 'env' }
  }

  if (await isOperatorUser(session.userId)) {
    return { userId: session.userId, via: 'role' }
  }

  return null
}

/**
 * Mark a user as an operator.
 *
 * Used by the bootstrap path — the first person on an empty install — and by
 * `/admin` when it needs a second pair of hands.
 */
export async function promoteToAdmin(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ role: 'admin', updatedAt: new Date() })
    .where(eq(users.id, userId.toLowerCase()))
}
