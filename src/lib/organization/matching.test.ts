import { describe, expect, test } from 'bun:test'

import {
  matchOrganizationRule,
  normaliseOrganizationRules,
  partitionOrganizationGroups,
} from './matching.ts'
import type { OrganizationRule } from './matching.ts'

const FACTS = {
  senderEmail: 'finance@acme.example',
  subject: 'Invoice for April',
  topic: 'Quarterly finance review',
  state: 'needs-action' as const,
}

function rule(
  overrides: Partial<OrganizationRule> & Pick<OrganizationRule, 'field' | 'value'>,
): OrganizationRule {
  return {
    id: 'rule-1',
    name: 'Finance',
    enabled: true,
    ...overrides,
  }
}

describe('normaliseOrganizationRules', () => {
  test('trims names and values and normalizes sender addresses', () => {
    expect(
      normaliseOrganizationRules([
        rule({ field: 'sender-email', value: ' Finance@Acme.Example ' }),
      ]),
    ).toEqual([
      rule({ field: 'sender-email', value: 'finance@acme.example' }),
    ])
  })

  test('rejects invalid fields, duplicate ids, and an invalid state', () => {
    expect(
      normaliseOrganizationRules([
        rule({ field: 'state-is', value: 'urgent' }),
      ]),
    ).toBeNull()
    expect(
      normaliseOrganizationRules([
        rule({ field: 'state-is', value: 'informational' }),
        rule({ id: 'rule-1', field: 'state-is', value: 'low-priority' }),
      ]),
    ).toBeNull()
    expect(
      normaliseOrganizationRules([
        { ...rule({ field: 'sender-domain', value: 'acme.example' }), field: 'regex' },
      ]),
    ).toBeNull()
  })
})

describe('matchOrganizationRule', () => {
  test('matches sender, sender domain, subject, topic, and state case-insensitively', () => {
    for (const candidate of [
      rule({ field: 'sender-email', value: 'FINANCE@ACME.EXAMPLE' }),
      rule({ field: 'sender-domain', value: 'ACME.EXAMPLE' }),
      rule({ field: 'subject-contains', value: 'INVOICE' }),
      rule({ field: 'topic-contains', value: 'FINANCE' }),
      rule({ field: 'state-is', value: 'needs-action' }),
    ]) {
      expect(matchOrganizationRule(FACTS, [candidate])).toBe(candidate)
    }
  })

  test('uses the first enabled match and ignores unmatched or disabled rules', () => {
    const disabled = rule({ id: 'disabled', field: 'subject-contains', value: 'invoice', enabled: false })
    const first = rule({ id: 'first', field: 'sender-domain', value: 'acme.example' })
    const later = rule({ id: 'later', field: 'state-is', value: 'needs-action' })

    expect(matchOrganizationRule(FACTS, [disabled, first, later])).toBe(first)
    expect(matchOrganizationRule(FACTS, [disabled])).toBeNull()
  })

  test('groups a conversation once and keeps Done outside custom groups', () => {
    const groupedRule = rule({ field: 'sender-domain', value: 'acme.example' })
    const items = [
      { id: 'one', done: false, organizationGroup: { id: groupedRule.id, name: groupedRule.name } },
      { id: 'two', done: false, organizationGroup: null },
      { id: 'three', done: true, organizationGroup: { id: groupedRule.id, name: groupedRule.name } },
    ]

    expect(partitionOrganizationGroups(items, [groupedRule])).toEqual({
      groups: [{ id: 'rule-1', name: 'Finance', items: [items[0]] }],
      ungrouped: [items[1]],
      done: [items[2]],
    })
  })

  test('does not match a suffix domain or an absent topic', () => {
    expect(
      matchOrganizationRule(FACTS, [
        rule({ field: 'sender-domain', value: 'example' }),
      ]),
    ).toBeNull()
    expect(
      matchOrganizationRule({ ...FACTS, topic: null }, [
        rule({ field: 'topic-contains', value: 'finance' }),
      ]),
    ).toBeNull()
  })
})
