import { asc, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { organizationRules, stateLabels } from '#/db/schema.ts'

import {
  normaliseStateLabels,
  resolveStateLabels,
  stateLabelOverrides,
} from './labels.ts'
import type { StateLabel, StateLabels } from './labels.ts'
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

  return rows.map(({ id, name, description, field, value, enabled }) => ({
    id,
    name,
    description,
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

/**
 * The four state labels as this user reads them.
 *
 * Defaults with their stored overrides applied, so the caller never has to know
 * whether a label was ever edited.
 */
export async function listStateLabels(userId: string): Promise<StateLabels> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return resolveStateLabels({})

  const rows = await db.query.stateLabels.findMany({
    where: eq(stateLabels.userId, owner),
  })

  return resolveStateLabels(
    Object.fromEntries(
      rows.map(({ state, name, description }) => [
        state,
        { name, description } satisfies StateLabel,
      ]),
    ),
  )
}

/**
 * Replace this user's label wording atomically.
 *
 * Only changed labels are stored (see `stateLabelOverrides`), so a label the
 * user never touched keeps following the app's own copy. The returned set is the
 * resolved four, which is what the page renders next.
 */
export async function saveStateLabels(
  userId: string,
  input: unknown,
): Promise<StateLabels | null> {
  const owner = userId.trim().toLowerCase()
  const labels = normaliseStateLabels(input)
  if (!owner || !labels) return null

  const resolved = resolveStateLabels(
    Object.fromEntries(
      labels.map(({ state, name, description }) => [
        state,
        { name, description } satisfies StateLabel,
      ]),
    ),
  )
  const overrides = stateLabelOverrides(resolved)
  const now = new Date()

  await db.transaction(async (tx) => {
    await tx.delete(stateLabels).where(eq(stateLabels.userId, owner))
    if (overrides.length > 0) {
      await tx.insert(stateLabels).values(
        overrides.map((label) => ({
          ...label,
          userId: owner,
          updatedAt: now,
        })),
      )
    }
  })

  return resolved
}
