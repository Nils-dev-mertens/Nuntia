/**
 * Who is in a workspace, and what they may change.
 *
 * The gate lives here rather than in the route, for the same reason the operator
 * guard does: a server function is an endpoint of its own, and a disabled button
 * is not an authorisation check. `/organisation` re-checks through these
 * functions on every action.
 *
 * The policy, decided once:
 *
 * - an `owner` may rename the workspace, edit its AI settings, and change roles;
 * - an `admin` may rename it and edit its AI settings, but cannot change roles —
 *   otherwise an admin could demote the owner who appointed them;
 * - a `member` may read the page and nothing else. Knowing who runs the workspace
 *   is not a secret, which is why this is a read-only page rather than a 404.
 */

import { and, eq, ne } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import {
  MEMBERSHIP_ROLES,
  memberships,
  organizations,
  users,
} from '#/db/schema.ts'
import type { MembershipRole } from '#/db/schema.ts'

import { ensureWorkspace } from './workspace.ts'
import type { Workspace } from './workspace.ts'

/** Roles allowed to change what the workspace shares (the name, the AI keys). */
export const WORKSPACE_MANAGER_ROLES: readonly MembershipRole[] = [
  'owner',
  'admin',
]

/** Roles allowed to change someone's role. */
export const WORKSPACE_ROLE_MANAGER_ROLES: readonly MembershipRole[] = ['owner']

export function canManageWorkspace(role: MembershipRole): boolean {
  return WORKSPACE_MANAGER_ROLES.includes(role)
}

export function canManageWorkspaceRoles(role: MembershipRole): boolean {
  return WORKSPACE_ROLE_MANAGER_ROLES.includes(role)
}

export const WORKSPACE_NAME_LIMIT = 80

export type WorkspaceMember = {
  userId: string
  email: string
  name: string | null
  role: MembershipRole
  joinedAt: string
}

/**
 * Everyone in the workspace, oldest membership first.
 *
 * Joined to `users` rather than stored twice: a member's address is the address
 * they sign in with, and a copy would drift the moment they changed it.
 */
export async function listWorkspaceMembers(
  organizationId: string,
): Promise<WorkspaceMember[]> {
  const rows = await db
    .select({
      userId: memberships.userId,
      email: users.email,
      name: users.name,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.organizationId, organizationId))

  return rows
    .map((row) => ({ ...row, joinedAt: row.joinedAt.toISOString() }))
    .sort(
      (a, b) =>
        a.joinedAt.localeCompare(b.joinedAt) || a.email.localeCompare(b.email),
    )
}

/** The workspace, if this member may change what it shares. */
export async function workspaceForManager(
  userId: string,
): Promise<Workspace | null> {
  const workspace = await ensureWorkspace(userId)
  if (!workspace) return null
  return canManageWorkspace(workspace.role) ? workspace : null
}

/**
 * Rename the workspace.
 *
 * A name is what the page and any future invitation say, so a blank one is
 * refused rather than stored: the fallback (the owner's own name) is a fact, and
 * an empty heading is not.
 */
export async function renameWorkspace(
  userId: string,
  name: string,
): Promise<{ error: string | null; name: string | null }> {
  const workspace = await workspaceForManager(userId)
  if (!workspace) {
    return {
      error: 'Only an owner or admin can rename this workspace.',
      name: null,
    }
  }

  const trimmed = name.trim()
  if (!trimmed || trimmed.length > WORKSPACE_NAME_LIMIT) {
    return {
      error: `A name is required, up to ${WORKSPACE_NAME_LIMIT} characters.`,
      name: null,
    }
  }

  await db
    .update(organizations)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(organizations.id, workspace.organizationId))

  return { error: null, name: trimmed }
}

/**
 * Change one member's role.
 *
 * Owner only, and the workspace must keep an owner: demoting the last one would
 * leave a company whose sharing settings nobody could change, with no in-app way
 * back. The install operator (`LUMEN_ADMIN_EMAILS`) is the break-glass path for
 * an install whose owner is gone, not a normal one.
 */
export async function setMemberRole(
  userId: string,
  memberUserId: string,
  role: MembershipRole,
): Promise<{ error: string | null }> {
  const workspace = await ensureWorkspace(userId)
  if (!workspace || !canManageWorkspaceRoles(workspace.role)) {
    return { error: 'Only the owner can change roles.' }
  }
  if (!(MEMBERSHIP_ROLES as readonly string[]).includes(role)) {
    return { error: 'That role does not exist.' }
  }

  const target = memberUserId.trim().toLowerCase()
  const [membership] = await db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, target),
        eq(memberships.organizationId, workspace.organizationId),
      ),
    )
    .limit(1)
  if (!membership) return { error: 'That person is not in this workspace.' }

  if (membership.role === 'owner' && role !== 'owner') {
    const others = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, workspace.organizationId),
          eq(memberships.role, 'owner'),
          ne(memberships.userId, target),
        ),
      )
    if (others.length === 0) {
      return {
        error:
          'This is the only owner. Make someone else an owner first, so the workspace is never left without one.',
      }
    }
  }

  await db
    .update(memberships)
    .set({ role })
    .where(
      and(
        eq(memberships.userId, target),
        eq(memberships.organizationId, workspace.organizationId),
      ),
    )

  return { error: null }
}
