import { describe, expect, test } from 'bun:test'

import { cursorKindFor } from './types.ts'

describe('cursorKindFor', () => {
  test('keeps each provider on its own stored cursor', () => {
    // Gmail's opaque history id and Graph's ISO timestamp are not
    // interchangeable; a shared kind would let one provider read the other's
    // value after an account changed hands.
    expect(cursorKindFor('google')).toBe('history')
    expect(cursorKindFor('microsoft')).toBe('received')
  })
})
