import { describe, expect, test } from 'bun:test'

import {
  matchOrganizationLabel,
  normaliseOrganizationLabels,
  partitionOrganizationGroups,
  resolveOrganizationGroup,
} from './matching.ts'
import type { OrganizationLabel } from './matching.ts'

const FACTS = {
  senderEmail: 'finance@acme.example',
  subject: 'Invoice for April',
  topic: 'Quarterly finance review',
  state: 'needs-action' as const,
}

function label(overrides: Partial<OrganizationLabel> = {}): OrganizationLabel {
  return {
    id: 'label-1',
    name: 'Finance',
    description: '',
    enabled: true,
    rules: [],
    ...overrides,
  }
}

function rule(
  field: OrganizationLabel['rules'][number]['field'],
  value: string,
  id = 'rule-1',
) {
  return { id, field, value }
}

describe('normaliseOrganizationLabels', () => {
  test('trims names and meanings and normalises sender values', () => {
    expect(
      normaliseOrganizationLabels([
        label({
          name: '  Finance ',
          description: '  Invoices and payments  ',
          rules: [rule('sender-email', ' Finance@Acme.Example ')],
        }),
      ]),
    ).toEqual([
      label({
        name: 'Finance',
        description: 'Invoices and payments',
        rules: [rule('sender-email', 'finance@acme.example')],
      }),
    ])
  })

  test('a label with no conditions needs a meaning', () => {
    // The meaning is the only thing that can place a thread in it, so a ruleless
    // label without one could never receive mail.
    expect(normaliseOrganizationLabels([label({ description: '   ' })])).toBeNull()
    expect(
      normaliseOrganizationLabels([
        label({ description: 'Invoices I still have to pay.' }),
      ]),
    ).toEqual([label({ description: 'Invoices I still have to pay.' })])
  })

  test('rejects duplicate ids across labels and across rules', () => {
    expect(
      normaliseOrganizationLabels([
        label({ id: 'same' }),
        label({ id: 'same', description: 'x', rules: [] }),
      ]),
    ).toBeNull()

    expect(
      normaliseOrganizationLabels([
        label({
          description: 'a',
          rules: [rule('sender-domain', 'a.example', 'dup')],
        }),
        label({
          id: 'other',
          description: 'b',
          rules: [rule('sender-domain', 'b.example', 'dup')],
        }),
      ]),
    ).toBeNull()
  })

  test('rejects invalid fields, an invalid state, and an empty value', () => {
    expect(
      normaliseOrganizationLabels([
        {
          ...label({ description: 'x' }),
          rules: [{ id: 'r', field: 'regex', value: 'x' }],
        },
      ]),
    ).toBeNull()
    expect(
      normaliseOrganizationLabels([
        label({ description: 'x', rules: [rule('state-is', 'urgent')] }),
      ]),
    ).toBeNull()
    expect(
      normaliseOrganizationLabels([
        label({ description: 'x', rules: [rule('subject-contains', '   ')] }),
      ]),
    ).toBeNull()
  })
})

describe('matchOrganizationLabel', () => {
  test('matches sender, sender domain, subject, topic, and state case-insensitively', () => {
    for (const candidate of [
      rule('sender-email', 'FINANCE@ACME.EXAMPLE'),
      rule('sender-domain', 'ACME.EXAMPLE'),
      rule('subject-contains', 'INVOICE'),
      rule('topic-contains', 'FINANCE'),
      rule('state-is', 'needs-action'),
    ]) {
      expect(
        matchOrganizationLabel(FACTS, [label({ rules: [candidate] })]),
      ).not.toBeNull()
    }
  })

  test('any one of a label’s conditions is enough', () => {
    // The point of the split: one section, several ways in.
    const invoices = label({
      name: 'Invoices',
      rules: [
        rule('sender-domain', 'stripe.example', 'r1'),
        rule('subject-contains', 'invoice', 'r2'),
      ],
    })

    expect(matchOrganizationLabel(FACTS, [invoices])?.name).toBe('Invoices')
  })

  test('uses the first enabled label and skips disabled ones', () => {
    const disabled = label({
      id: 'disabled',
      enabled: false,
      rules: [rule('subject-contains', 'invoice')],
    })
    const first = label({ id: 'first', rules: [rule('sender-domain', 'acme.example')] })
    const later = label({
      id: 'later',
      rules: [rule('state-is', 'needs-action', 'r3')],
    })

    expect(matchOrganizationLabel(FACTS, [disabled, first, later])?.id).toBe(
      'first',
    )
    expect(matchOrganizationLabel(FACTS, [disabled])).toBeNull()
  })

  test('a label with no conditions is never matched by fields', () => {
    // It is the model's to place, not this function's.
    expect(
      matchOrganizationLabel(FACTS, [
        label({ description: 'Invoices to pay', rules: [] }),
      ]),
    ).toBeNull()
  })

  test('does not match a suffix domain or an absent topic', () => {
    expect(
      matchOrganizationLabel(FACTS, [
        label({ rules: [rule('sender-domain', 'example')] }),
      ]),
    ).toBeNull()
    expect(
      matchOrganizationLabel({ ...FACTS, topic: null }, [
        label({ rules: [rule('topic-contains', 'finance')] }),
      ]),
    ).toBeNull()
  })
})

describe('grouping', () => {
  test('groups a conversation once and keeps Done outside custom labels', () => {
    const finance = label({ rules: [rule('sender-domain', 'acme.example')] })
    const items = [
      {
        id: 'one',
        done: false,
        organizationGroup: { id: finance.id, name: finance.name },
      },
      { id: 'two', done: false, organizationGroup: null },
      {
        id: 'three',
        done: true,
        organizationGroup: { id: finance.id, name: finance.name },
      },
    ]

    expect(partitionOrganizationGroups(items, [finance])).toEqual({
      groups: [
        { id: 'label-1', name: 'Finance', description: '', items: [items[0]] },
      ],
      ungrouped: [items[1]],
      done: [items[2]],
    })
  })

  test('the label the user moved a thread into outranks a rule that also matches', () => {
    const finance = label({ rules: [rule('sender-domain', 'acme.example')] })
    const clients = { ...finance, id: 'label-clients', name: 'Clients' }

    expect(
      resolveOrganizationGroup(clients.id, FACTS, [finance, clients]),
    ).toBe(clients)
    expect(resolveOrganizationGroup(null, FACTS, [finance, clients])).toBe(
      finance,
    )
  })

  test('an assignment to a label that is gone falls back to the rules', () => {
    const finance = label({ rules: [rule('sender-domain', 'acme.example')] })

    expect(
      resolveOrganizationGroup('deleted-label', FACTS, [finance]),
    ).toBe(finance)
    // Disabled is gone as far as filing is concerned: the thread goes back to
    // the rules rather than into a section nobody can see.
    expect(
      resolveOrganizationGroup(finance.id, FACTS, [
        { ...finance, enabled: false },
      ]),
    ).toBeNull()
  })
})
