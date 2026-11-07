/**
 * The team directory: the people a user can @mention.
 *
 * Scoped to the signed-in user, not to an organisation. An organisation-wide
 * directory is a different decision (see `docs/organizations.md`); this is the
 * smallest honest version — one person's colleagues, each with the one thing a
 * mention picker needs beside a name: what they handle.
 */

import { randomUUID } from 'node:crypto'

import { and, asc, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { teamMembers } from '#/db/schema.ts'

import { normaliseTeamMemberInput } from './types.ts'
import type { TeamMember } from './types.ts'

function ownerKey(userId: string): string {
  return userId.trim().toLowerCase()
}

function toTeamMember(row: {
  id: string
  name: string
  email: string
  role: string | null
}): TeamMember {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
  }
}

/** Everyone on this user's team, in the order the picker shows them. */
export async function listTeamMembers(userId: string): Promise<TeamMember[]> {
  const owner = ownerKey(userId)
  if (!owner) return []

  const rows = await db.query.teamMembers.findMany({
    where: eq(teamMembers.userId, owner),
    orderBy: [asc(teamMembers.name), asc(teamMembers.email)],
  })

  return rows.map(toTeamMember)
}

/**
 * Add a member, or update one the user is editing.
 *
 * The address is the identity: adding a colleague who is already listed is a
 * mistake worth naming rather than a silent update that overwrites their role,
 * and editing one member onto another's address would break the unique index.
 */
export async function saveTeamMember(
  userId: string,
  input: unknown,
): Promise<{ member: TeamMember | null; error: string | null }> {
  const owner = ownerKey(userId)
  if (!owner) return { member: null, error: 'You are not signed in.' }

  const normalised = normaliseTeamMemberInput(input)
  if (!normalised) {
    return {
      member: null,
      error: `Give a name, a valid email address, and keep the role under its limit.`,
    }
  }

  const [byId, byEmail] = await Promise.all([
    normalised.id
      ? db.query.teamMembers.findFirst({
          where: and(
            eq(teamMembers.id, normalised.id),
            eq(teamMembers.userId, owner),
          ),
        })
      : Promise.resolve(null),
    db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.userId, owner),
        eq(teamMembers.email, normalised.email),
      ),
    }),
  ])

  if (normalised.id && !byId) {
    return { member: null, error: 'That team member no longer exists.' }
  }
  if (byEmail && byEmail.id !== normalised.id) {
    return {
      member: null,
      error: `${normalised.email} is already on your team.`,
    }
  }

  const now = new Date()
  if (byId) {
    await db
      .update(teamMembers)
      .set({
        name: normalised.name,
        email: normalised.email,
        role: normalised.role,
        updatedAt: now,
      })
      .where(and(eq(teamMembers.id, byId.id), eq(teamMembers.userId, owner)))

    return {
      member: {
        id: byId.id,
        name: normalised.name,
        email: normalised.email,
        role: normalised.role,
      },
      error: null,
    }
  }

  const id = randomUUID()
  await db.insert(teamMembers).values({
    id,
    userId: owner,
    name: normalised.name,
    email: normalised.email,
    role: normalised.role,
    createdAt: now,
    updatedAt: now,
  })

  return {
    member: {
      id,
      name: normalised.name,
      email: normalised.email,
      role: normalised.role,
    },
    error: null,
  }
}

/** Remove one member; false when the id was not this user's. */
export async function removeTeamMember(
  userId: string,
  id: string,
): Promise<boolean> {
  const owner = ownerKey(userId)
  const target = id.trim()
  if (!owner || !target) return false

  const existing = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.id, target), eq(teamMembers.userId, owner)),
    columns: { id: true },
  })
  if (!existing) return false

  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.id, target), eq(teamMembers.userId, owner)))

  return true
}
