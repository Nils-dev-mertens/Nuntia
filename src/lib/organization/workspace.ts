/**
 * The workspace the signed-in person acts in.
 *
 * One organisation per member, decided before the migration. That constraint is
 * what keeps this helper honest: the workspace id is derived from the user rather
 * than taken from the browser, so no request can name someone else's workspace
 * and get an answer.
 *
 * `ensureWorkspace` is the only entry point, and it creates the solo workspace
 * on first use. The migration backfills one for every user who existed when
 * organisations landed, and this covers the users created afterwards — a sign-up,
 * an invite, or a test fixture — so no caller has to remember to do it.
 */

import { eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { memberships, organizations, users } from '#/db/schema.ts'
import type { MembershipRole, OrganizationKind } from '#/db/schema.ts'

export type Workspace = {
  organizationId: string
  name: string
  kind: OrganizationKind
  role: MembershipRole
}

/** The deterministic id of a person's own workspace. */
export function soloOrganizationId(userId: string): string {
  return `org:${userId.trim().toLowerCase()}`
}

async function readWorkspace(userId: string): Promise<Workspace | null> {
  const [membership] = await db
    .select({
      organizationId: memberships.organizationId,
      role: memberships.role,
    })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1)
  if (!membership) return null

  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, membership.organizationId))
    .limit(1)
  if (!organization) return null

  return {
    organizationId: organization.id,
    name: organization.name,
    kind: organization.kind,
    role: membership.role,
  }
}

/**
 * The member's workspace, created as a solo one if they have none.
 *
 * Returns null when there is no such user: a workspace belongs to a person, and
 * inventing one for an address that never signed up would put an orphan client
 * list in the database. Callers treat null as "no workspace, nothing shared".
 *
 * Both inserts conflict-do-nothing, so two requests racing on a member's first
 * save produce one workspace rather than a constraint error.
 */
export async function ensureWorkspace(
  userId: string,
): Promise<Workspace | null> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return null

  const existing = await readWorkspace(owner)
  if (existing) return existing

  const [user] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, owner))
    .limit(1)
  if (!user) return null

  const organizationId = soloOrganizationId(owner)
  await db
    .insert(organizations)
    .values({
      id: organizationId,
      // A workspace needs a name to show anywhere it is listed; the person's own
      // name is the only one that exists at this point, and it is what they would
      // have typed. It is renameable later.
      name: user.name?.trim() || user.email,
      kind: 'solo',
    })
    .onConflictDoNothing()

  await db
    .insert(memberships)
    .values({
      id: `mem:${owner}`,
      organizationId,
      userId: owner,
      role: 'owner',
    })
    .onConflictDoNothing()

  return readWorkspace(owner)
}
