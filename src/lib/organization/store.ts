import { asc, eq, inArray } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import {
  organizationLabels,
  organizationRules,
  stateLabels,
} from '#/db/schema.ts'
import { ensureWorkspace } from '#/lib/organization/workspace.ts'

import {
  normaliseStateLabels,
  resolveStateLabels,
  stateLabelOverrides,
} from './labels.ts'
import type { StateLabel, StateLabels } from './labels.ts'
import { normaliseOrganizationLabels } from './matching.ts'
import type {
  MeaningLabel,
  OrganizationLabel,
  OrganizationMatchRule,
} from './matching.ts'

/**
 * The workspace's labels, in their arranged order, each with its rules.
 *
 * Read through the member's workspace rather than the member: a section is shared
 * filing, so a colleague's "Invoices" is this inbox's "Invoices" too. The caller
 * still names a user, so no query can reach a workspace the reader is not in.
 *
 * Two queries rather than a join: the rules come back flat and are grouped here,
 * which keeps a label with no rules a row with an empty array instead of a row
 * that vanishes for want of a match.
 */
export async function listOrganizationLabels(
  userId: string,
): Promise<OrganizationLabel[]> {
  const workspace = await ensureWorkspace(userId)
  if (!workspace) return []

  const labels = await db.query.organizationLabels.findMany({
    where: eq(organizationLabels.organizationId, workspace.organizationId),
    orderBy: [
      asc(organizationLabels.position),
      asc(organizationLabels.createdAt),
    ],
  })
  if (labels.length === 0) return []

  const rules = await db.query.organizationRules.findMany({
    where: inArray(
      organizationRules.labelId,
      labels.map((label) => label.id),
    ),
    orderBy: [asc(organizationRules.position)],
  })

  const rulesByLabel = new Map<string, OrganizationMatchRule[]>()
  for (const rule of rules) {
    const list = rulesByLabel.get(rule.labelId) ?? []
    list.push({ id: rule.id, field: rule.field, value: rule.value })
    rulesByLabel.set(rule.labelId, list)
  }

  return labels.map((label) => ({
    id: label.id,
    name: label.name,
    description: label.description,
    enabled: label.enabled,
    rules: rulesByLabel.get(label.id) ?? [],
  }))
}

/**
 * Replace the workspace's labels and every rule they carry, atomically.
 *
 * Delete-then-insert rather than a diff, the same as the rules list has always
 * been: the form submits the whole set, so a label removed on screen has to be
 * removed here, and a stale rule is worse than a rewritten one. Invalid input
 * leaves storage untouched.
 *
 * Any member may save: the set is shared filing rather than a credential, and a
 * section is only useful if the people doing the filing can change it. The roles
 * that gate renaming the workspace and spending its AI budget are a different
 * question and stay on `/organisation`.
 */
export async function saveOrganizationLabels(
  userId: string,
  input: unknown,
): Promise<OrganizationLabel[] | null> {
  const workspace = await ensureWorkspace(userId)
  const labels = normaliseOrganizationLabels(input)
  if (!workspace || !labels) return null

  const organizationId = workspace.organizationId
  const now = new Date()
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: organizationLabels.id })
      .from(organizationLabels)
      .where(eq(organizationLabels.organizationId, organizationId))

    // Explicit, even though the foreign key cascades: a test or a manual
    // delete that ran without `PRAGMA foreign_keys` would otherwise leave rules
    // pointing at labels that no longer exist.
    if (existing.length > 0) {
      await tx.delete(organizationRules).where(
        inArray(
          organizationRules.labelId,
          existing.map((row) => row.id),
        ),
      )
    }
    await tx
      .delete(organizationLabels)
      .where(eq(organizationLabels.organizationId, organizationId))

    if (labels.length > 0) {
      await tx.insert(organizationLabels).values(
        labels.map((label, position) => ({
          id: label.id,
          organizationId,
          name: label.name,
          description: label.description,
          enabled: label.enabled,
          position,
          createdAt: now,
          updatedAt: now,
        })),
      )
    }

    const rules = labels.flatMap((label) =>
      label.rules.map((rule, position) => ({
        id: rule.id,
        labelId: label.id,
        field: rule.field,
        value: rule.value,
        position,
      })),
    )
    if (rules.length > 0) await tx.insert(organizationRules).values(rules)
  })

  return labels
}

/**
 * The labels the decision model may file threads into.
 *
 * Enabled, described, and carrying no rules at all — a label with a rule is
 * already decided by that rule, and offering it to the model would set the two
 * against each other. Read once per sync batch, like the state meanings, because
 * the answer does not change inside one run.
 */
export async function listMeaningLabels(
  userId: string,
): Promise<MeaningLabel[]> {
  const labels = await listOrganizationLabels(userId)

  return labels
    .filter(
      (label) =>
        label.enabled &&
        label.rules.length === 0 &&
        label.description.trim().length > 0,
    )
    .map(({ id, name, description }) => ({
      id,
      name,
      description: description.trim(),
    }))
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
