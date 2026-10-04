import { describe, expect, test } from 'bun:test'

import { DEFAULT_STALE_AFTER_MS, isCursorStale } from './freshness.ts'

const NOW = 1_700_000_000_000

/** `ago` milliseconds before NOW. */
function since(ago: number): Date {
  return new Date(NOW - ago)
}

describe('isCursorStale', () => {
  test('an account that has never synced is stale', () => {
    // The case that matters most: treating null as fresh would leave a new
    // account with a permanently empty inbox and nothing to indicate why.
    expect(isCursorStale(null, DEFAULT_STALE_AFTER_MS, NOW)).toBe(true)
  })

  test('a just-synced cursor is fresh', () => {
    expect(isCursorStale(since(1_000), DEFAULT_STALE_AFTER_MS, NOW)).toBe(false)
  })

  test('a cursor within the window is fresh', () => {
    expect(
      isCursorStale(since(DEFAULT_STALE_AFTER_MS - 1), DEFAULT_STALE_AFTER_MS, NOW),
    ).toBe(false)
  })

  test('a cursor exactly at the window is stale', () => {
    // >= rather than >, so a cursor cannot sit on the boundary forever and be
    // considered fresh after every subsequent poll.
    expect(
      isCursorStale(since(DEFAULT_STALE_AFTER_MS), DEFAULT_STALE_AFTER_MS, NOW),
    ).toBe(true)
  })

  test('an old cursor is stale', () => {
    expect(isCursorStale(since(10 * 60_000), DEFAULT_STALE_AFTER_MS, NOW)).toBe(
      true,
    )
  })

  test('the threshold is configurable', () => {
    const tenMinutes = 10 * 60_000

    expect(isCursorStale(since(5 * 60_000), tenMinutes, NOW)).toBe(false)
    expect(isCursorStale(since(15 * 60_000), tenMinutes, NOW)).toBe(true)
  })

  test('a clock that jumps backwards does not report stale forever', () => {
    // A timestamp in the future means the stored value is untrustworthy; the
    // safe reading is "sync and find out", not "skip for an hour".
    expect(isCursorStale(new Date(NOW + 60_000), DEFAULT_STALE_AFTER_MS, NOW)).toBe(
      true,
    )
  })
})