import { describe, expect, test } from 'bun:test'

import {
  defaultInboxOrder,
  labelToken,
  resolveInboxOrder,
  stateToken,
} from './inbox-order.ts'

describe('inbox section order', () => {
  test('defaults to needs action, then the labels, then the other groups', () => {
    expect(defaultInboxOrder(['a', 'b'])).toEqual([
      'state:needs-action',
      'label:a',
      'label:b',
      'state:waiting-for-reply',
      'state:informational',
      'state:low-priority',
    ])
  })

  test('keeps a label dragged between two AI groups', () => {
    const order = [
      stateToken('needs-action'),
      stateToken('waiting-for-reply'),
      labelToken('clients'),
      stateToken('informational'),
      stateToken('low-priority'),
    ]

    expect(resolveInboxOrder(order, ['clients'])).toEqual(order)
  })

  test('drops unknown and duplicate tokens and appends what is missing', () => {
    expect(
      resolveInboxOrder(
        ['label:gone', 'state:informational', 'state:informational'],
        ['clients'],
      ),
    ).toEqual([
      'state:informational',
      'state:needs-action',
      'label:clients',
      'state:waiting-for-reply',
      'state:low-priority',
    ])
  })

  test('treats a malformed value as no preference', () => {
    expect(resolveInboxOrder({ nope: true }, [])).toEqual(defaultInboxOrder([]))
  })
})
