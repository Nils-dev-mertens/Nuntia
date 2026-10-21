import type { ConversationState } from '#/db/schema.ts'

export const ORGANIZATION_RULE_FIELDS = [
  'sender-email',
  'sender-domain',
  'subject-contains',
  'topic-contains',
  'state-is',
] as const

export type OrganizationRuleField = (typeof ORGANIZATION_RULE_FIELDS)[number]

export type OrganizationRule = {
  id: string
  name: string
  field: OrganizationRuleField
  value: string
  enabled: boolean
}

export type OrganizationRuleInput = OrganizationRule

export type OrganizationGroupedItem = {
  done: boolean
  organizationGroup: { id: string; name: string } | null
}

export function partitionOrganizationGroups<T extends OrganizationGroupedItem>(
  items: T[],
  rules: OrganizationRule[],
): {
  groups: Array<{ id: string; name: string; items: T[] }>
  ungrouped: T[]
  done: T[]
} {
  const groups = rules
    .filter((rule) => rule.enabled)
    .map((rule) => ({ id: rule.id, name: rule.name, items: [] as T[] }))
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

  return { groups: groups.filter((group) => group.items.length > 0), ungrouped, done }
}

export type OrganizationRuleFacts = {
  senderEmail: string | null
  subject: string
  topic: string | null
  state: ConversationState
}

export const ORGANIZATION_RULE_LIMITS = {
  count: 50,
  id: 80,
  name: 80,
  value: 200,
} as const

const STATE_VALUES = new Set<string>([
  'needs-action',
  'waiting-for-reply',
  'informational',
  'low-priority',
])

/** Normalize and validate a rule list before it is persisted. */
export function normaliseOrganizationRules(
  input: unknown,
): OrganizationRule[] | null {
  if (!Array.isArray(input) || input.length > ORGANIZATION_RULE_LIMITS.count) {
    return null
  }

  const ids = new Set<string>()
  const rules: OrganizationRule[] = []

  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') return null
    const rule = candidate as Record<string, unknown>
    if (
      typeof rule.id !== 'string' ||
      typeof rule.name !== 'string' ||
      typeof rule.field !== 'string' ||
      typeof rule.value !== 'string' ||
      typeof rule.enabled !== 'boolean' ||
      !(ORGANIZATION_RULE_FIELDS as readonly string[]).includes(rule.field)
    ) {
      return null
    }

    const id = rule.id.trim()
    const name = rule.name.trim()
    const value = rule.value.trim()
    if (
      !id ||
      id.length > ORGANIZATION_RULE_LIMITS.id ||
      !name ||
      name.length > ORGANIZATION_RULE_LIMITS.name ||
      !value ||
      value.length > ORGANIZATION_RULE_LIMITS.value ||
      ids.has(id)
    ) {
      return null
    }
    if (rule.field === 'state-is' && !STATE_VALUES.has(value)) return null
    if (
      rule.field === 'sender-email' &&
      (!/^[^\s@]+@[^\s@]+$/.test(value) || value.length > 254)
    ) {
      return null
    }
    if (
      rule.field === 'sender-domain' &&
      (/[\s@]/.test(value) || value.startsWith('.') || value.endsWith('.'))
    ) {
      return null
    }

    ids.add(id)
    rules.push({
      id,
      name,
      field: rule.field as OrganizationRuleField,
      value:
        rule.field === 'sender-email' || rule.field === 'sender-domain'
          ? value.replace(/^@/, '').toLowerCase()
          : value,
      enabled: rule.enabled,
    })
  }

  return rules
}

/** Return the first matching enabled rule; caller owns ordering. */
export function matchOrganizationRule(
  facts: OrganizationRuleFacts,
  rules: OrganizationRule[],
): OrganizationRule | null {
  const sender = facts.senderEmail?.trim().toLowerCase() ?? ''
  const subject = facts.subject.toLocaleLowerCase()
  const topic = facts.topic?.toLocaleLowerCase() ?? ''

  return (
    rules.find((rule) => {
      if (!rule.enabled) return false
      const value = rule.value.toLocaleLowerCase()
      switch (rule.field) {
        case 'sender-email':
          return sender === value
        case 'sender-domain':
          return sender.split('@').at(-1) === value
        case 'subject-contains':
          return subject.includes(value)
        case 'topic-contains':
          return topic.includes(value)
        case 'state-is':
          return facts.state === rule.value
      }
    }) ?? null
  )
}
