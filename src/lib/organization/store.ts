import { asc, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { organizationRules } from '#/db/schema.ts'

import { normaliseOrganizationRules } from './matching.ts'
import type { OrganizationRule } from './matching.ts'

export async function listOrganizationRules(
  userId: string,
): Promise<OrganizationRule[]> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return []

  const rows = await db.query.organizationRules.findMany({
    where: eq(organizationRules.userId, owner),
    orderBy: [asc(organizationRules.position), asc(organizationRules.createdAt)],
  })

  return rows.map(({ id, name, field, value, enabled }) => ({
    id,
    name,
    field,
    value,
    enabled,
  }))
}

/** Replace the user's ordered rules atomically; invalid input leaves storage intact. */
export async function saveOrganizationRules(
  userId: string,
  input: unknown,
): Promise<OrganizationRule[] | null> {
  const owner = userId.trim().toLowerCase()
  const rules = normaliseOrganizationRules(input)
  if (!owner || !rules) return null

  const now = new Date()
  await db.transaction(async (tx) => {
    await tx.delete(organizationRules).where(eq(organizationRules.userId, owner))
    if (rules.length > 0) {
      await tx.insert(organizationRules).values(
        rules.map((rule, position) => ({
          ...rule,
          userId: owner,
          position,
          createdAt: now,
          updatedAt: now,
        })),
      )
    }
  })

  return rules
}
