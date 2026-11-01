import { describe, expect, test } from 'bun:test'

import {
  matchOrganizationLabel,
  normaliseOrganizationLabels,
  resolveOrganizationGroup,
} from './matching.ts'
import type { OrganizationLabel } from './matching.ts'
import { parseMeaning } from './state-meaning.ts'

const FACTS = {
  senderEmail: 'billing@northwind.example',
  subject: 'Invoice 4021',
  topic: 'Quarterly invoice',
  state: 'needs-action' as const,
}

function label(overrides: Partial<OrganizationLabel> = {}): OrganizationLabel {
  return {
    id: 'label-1',
    name: 'To pay',
    description: 'Invoices waiting for a payment from me.',
    enabled: true,
    rules: [],
    ...overrides,
  }
}

describe('a label with no conditions', () => {
  test('is valid with a meaning and no rules', () => {
    expect(
      normaliseOrganizationLabels([label()]),
    ).toEqual([label()])
  })

  test('needs a meaning, because that is what it is matched on', () => {
    expect(normaliseOrganizationLabels([label({ description: '   ' })])).toBeNull()
  })

  test('never matches on the thread’s own fields', () => {
    // The whole point of the split: no condition means only judgement can place
    // a thread, so nothing here may claim one off a substring.
    expect(matchOrganizationLabel(FACTS, [label()])).toBeNull()
  })

  test('still wins when the thread was put in it by hand', () => {
    expect(resolveOrganizationGroup('label-1', FACTS, [label()])?.name).toBe(
      'To pay',
    )
  })

  test('is skipped once it is disabled', () => {
    expect(
      resolveOrganizationGroup('label-1', FACTS, [label({ enabled: false })]),
    ).toBeNull()
  })
})

describe('a label with conditions still matches as it did', () => {
  test('sender domain labels are unaffected by the split', () => {
    const [normalised] = normaliseOrganizationLabels([
      label({
        name: 'Northwind',
        description: '',
        rules: [
          { id: 'rule-1', field: 'sender-domain', value: 'Northwind.example' },
        ],
      }),
    ])!

    expect(matchOrganizationLabel(FACTS, [normalised])?.id).toBe('label-1')
    // The value is normalised, which the meaning path never needs.
    expect(normalised.rules[0].value).toBe('northwind.example')
  })
})

describe('parseMeaning', () => {
  test('strips fences, quotes and collapsed whitespace', () => {
    expect(parseMeaning('```\n"You must answer this."\n```')).toBe(
      'You must answer this.',
    )
    expect(parseMeaning('  Do  this.  ')).toBe('Do this.')
  })

  test('returns null for nothing', () => {
    expect(parseMeaning('')).toBeNull()
    expect(parseMeaning('""')).toBeNull()
  })

  test('caps at the column’s size', () => {
    const parsed = parseMeaning('a'.repeat(400))
    expect(parsed?.length).toBe(300)
    expect(parsed?.endsWith('…')).toBe(true)
  })
})
