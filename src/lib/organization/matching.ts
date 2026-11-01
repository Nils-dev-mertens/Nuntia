/**
 * Custom labels and how a thread is found for one.
 *
 * A label is a section: a name, a meaning, whether it is shown, and where it
 * sits. A rule is one test against a thread. The two are separate because they
 * answer different questions, and because a label may need several — `invoices`
 * can be a sender domain *or* a subject line — or none at all, in which case the
 * description is what places a thread and the decision model does the reading.
 *
 * Everything here is pure: no database, no AI, no settings.
 */

import type { ConversationState } from '#/db/schema.ts'

/** The tests a rule may run. There is no `meaning`: that is the absence of one. */
export const ORGANIZATION_RULE_FIELDS = [
  'sender-email',
  'sender-domain',
  'subject-contains',
  'topic-contains',
  'state-is',
] as const

export type OrganizationRuleField = (typeof ORGANIZATION_RULE_FIELDS)[number]

export type OrganizationMatchRule = {
  /** Stable while the form is open; it is also the row's primary key. */
  id: string
  field: OrganizationRuleField
  value: string
}

export type OrganizationLabel = {
  id: string
  name: string
  /** What the label is for, in the user's words; shown under the heading. */
  description: string
  enabled: boolean
  /**
   * How threads are found for it.
   *
   * Empty means the label is placed by judgement: the decision model reads the
   * description against the mail. A label with rules is settled deterministically
   * and never offered to the model.
   */
  rules: OrganizationMatchRule[]
}

/**
 * A label the decision model may file a thread into.
 *
 * The same shape as `OrganizationLabel`, narrowed by the caller: only labels with
 * no rules belong in this list.
 */
export type MeaningLabel = {
  id: string
  name: string
  /** What the label is for. This is what it is matched on. */
  description: string
}

export type OrganizationGroupedItem = {
  done: boolean
  organizationGroup: { id: string; name: string } | null
}

export type OrganizationGroup<T> = {
  id: string
  name: string
  description: string
  items: T[]
}

export function partitionOrganizationGroups<T extends OrganizationGroupedItem>(
  items: T[],
  labels: OrganizationLabel[],
): {
  groups: Array<OrganizationGroup<T>>
  ungrouped: T[]
  done: T[]
} {
  const groups = labels
    .filter((label) => label.enabled)
    .map((label) => ({
      id: label.id,
      name: label.name,
      description: label.description,
      items: [] as T[],
    }))
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const ungrouped: T[] = []
  const done: T[] = []

  for (const item of items) {
    if (item.done) {
      done.push(item)
      continue
    }
    const group = item.organizationGroup
      ? groupById.get(item.organizationGroup.id)
      : undefined
    if (group) group.items.push(item)
    else ungrouped.push(item)
  }

  return {
    groups: groups.filter((group) => group.items.length > 0),
    ungrouped,
    done,
  }
}

export type OrganizationRuleFacts = {
  senderEmail: string | null
  subject: string
  topic: string | null
  state: ConversationState
}

export const ORGANIZATION_RULE_LIMITS = {
  /** Labels, not rules: each label may carry `rules` of them. */
  count: 50,
  id: 80,
  name: 80,
  description: 300,
  value: 200,
  /** Tests one label may carry. Alternatives, not conditions. */
  rules: 10,
} as const

const STATE_VALUES = new Set<string>([
  'needs-action',
  'waiting-for-reply',
  'informational',
  'low-priority',
])

/**
 * Validate and normalise a submitted set of labels before it is persisted.
 *
 * A label with no rules must have a meaning: it is the only thing that can place
 * a thread in it, so a ruleless label with an empty description could never
 * receive one — a section that exists and can never be used is a form bug, not a
 * choice worth storing.
 */
export function normaliseOrganizationLabels(
  input: unknown,
): OrganizationLabel[] | null {
  if (!Array.isArray(input) || input.length > ORGANIZATION_RULE_LIMITS.count) {
    return null
  }

  const labelIds = new Set<string>()
  const ruleIds = new Set<string>()
  const labels: OrganizationLabel[] = []

  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') return null
    const entry = candidate as Record<string, unknown>
    if (
      typeof entry.id !== 'string' ||
      typeof entry.name !== 'string' ||
      typeof entry.enabled !== 'boolean' ||
      !Array.isArray(entry.rules)
    ) {
      return null
    }

    const id = entry.id.trim()
    const name = entry.name.trim()
    // Optional on the wire so a label saved before meanings existed still loads;
    // the stored column is non-null.
    const description =
      typeof entry.description === 'string' ? entry.description.trim() : ''

    if (
      !id ||
      id.length > ORGANIZATION_RULE_LIMITS.id ||
      !name ||
      name.length > ORGANIZATION_RULE_LIMITS.name ||
      description.length > ORGANIZATION_RULE_LIMITS.description ||
      labelIds.has(id)
    ) {
      return null
    }

    if (
      entry.rules.length > ORGANIZATION_RULE_LIMITS.rules ||
      (entry.rules.length === 0 && !description)
    ) {
      return null
    }

    const rules: OrganizationMatchRule[] = []
    for (const ruleCandidate of entry.rules) {
      if (!ruleCandidate || typeof ruleCandidate !== 'object') return null
      const rule = ruleCandidate as Record<string, unknown>
      if (
        typeof rule.id !== 'string' ||
        typeof rule.field !== 'string' ||
        typeof rule.value !== 'string' ||
        !(ORGANIZATION_RULE_FIELDS as readonly string[]).includes(rule.field)
      ) {
        return null
      }

      const ruleId = rule.id.trim()
      const value = rule.value.trim()
      if (
        !ruleId ||
        ruleId.length > ORGANIZATION_RULE_LIMITS.id ||
        // Across the whole set, not just this label: the id is a primary key.
        ruleIds.has(ruleId) ||
        !value ||
        value.length > ORGANIZATION_RULE_LIMITS.value
      ) {
        return null
      }

      const field = rule.field as OrganizationRuleField
      if (field === 'state-is' && !STATE_VALUES.has(value)) return null
      if (
        field === 'sender-email' &&
        (!/^[^\s@]+@[^\s@]+$/.test(value) || value.length > 254)
      ) {
        return null
      }
      if (
        field === 'sender-domain' &&
        (/[\s@]/.test(value) || value.startsWith('.') || value.endsWith('.'))
      ) {
        return null
      }

      ruleIds.add(ruleId)
      rules.push({
        id: ruleId,
        field,
        value:
          field === 'sender-email' || field === 'sender-domain'
            ? value.replace(/^@/, '').toLowerCase()
            : value,
      })
    }

    labelIds.add(id)
    labels.push({ id, name, description, enabled: entry.enabled, rules })
  }

  return labels
}

/**
 * Which custom label a conversation belongs to.
 *
 * The user's own move wins, and the rules are the fallback: a thread filed by
 * hand stays where it was put even when a rule that also matches it exists. An
 * assignment to a label that has since been deleted or disabled is ignored rather
 * than honoured, so the thread lands somewhere instead of disappearing from every
 * section.
 */
export function resolveOrganizationGroup(
  assignedId: string | null,
  facts: OrganizationRuleFacts,
  labels: OrganizationLabel[],
): OrganizationLabel | null {
  if (assignedId) {
    const assigned = labels.find(
      (label) => label.id === assignedId && label.enabled,
    )
    if (assigned) return assigned
  }

  return matchOrganizationLabel(facts, labels)
}

/**
 * The first enabled label with a rule that matches; caller owns label order.
 *
 * Within a label the rules are alternatives, so the first hit names the label and
 * the rest are not consulted. A label with no rules can never match here — that
 * is the whole point of the split, and why it is never offered to this function
 * as a candidate.
 */
export function matchOrganizationLabel(
  facts: OrganizationRuleFacts,
  labels: OrganizationLabel[],
): OrganizationLabel | null {
  const sender = facts.senderEmail?.trim().toLowerCase() ?? ''
  const subject = facts.subject.toLocaleLowerCase()
  const topic = facts.topic?.toLocaleLowerCase() ?? ''

  for (const label of labels) {
    if (!label.enabled) continue

    for (const rule of label.rules) {
      const value = rule.value.toLocaleLowerCase()
      switch (rule.field) {
        case 'sender-email':
          if (sender === value) return label
          break
        case 'sender-domain':
          if (sender.split('@').at(-1) === value) return label
          break
        case 'subject-contains':
          if (subject.includes(value)) return label
          break
        case 'topic-contains':
          if (topic.includes(value)) return label
          break
        case 'state-is':
          if (facts.state === rule.value) return label
          break
      }
    }
  }

  return null
}
