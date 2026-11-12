import { describe, expect, test } from 'bun:test'

import {
  normaliseContactTag,
  normaliseContactTagDescription,
  normaliseContactTagList,
  sortContactTags,
  tagDescriptionNeedsRefresh,
} from './tag-name.ts'

describe('normaliseContactTag', () => {
  test('trims a plain tag', () => {
    expect(normaliseContactTag('  investor ')).toBe('investor')
  })

  test('drops the hash people type when writing a tag', () => {
    expect(normaliseContactTag('#waiting on legal')).toBe('waiting on legal')
  })

  test('collapses inner whitespace so one tag is one chip', () => {
    expect(normaliseContactTag('waiting   on\tlegal')).toBe('waiting on legal')
  })

  test('keeps the case the user typed', () => {
    expect(normaliseContactTag('Acme Corp')).toBe('Acme Corp')
  })

  test('rejects empty input and a bare hash', () => {
    expect(normaliseContactTag('')).toBeNull()
    expect(normaliseContactTag('   ')).toBeNull()
    expect(normaliseContactTag('#')).toBeNull()
  })

  test('rejects a tag longer than the chip can hold', () => {
    expect(normaliseContactTag('a'.repeat(32))).toBe('a'.repeat(32))
    expect(normaliseContactTag('a'.repeat(33))).toBeNull()
  })
})

describe('normaliseContactTagList', () => {
  test('cleans a proposal and drops what is not a tag', () => {
    expect(
      normaliseContactTagList([' investor ', 42, '', 'Acme', '#legal']),
    ).toEqual(['investor', 'Acme', 'legal'])
  })

  test('de-duplicates case-insensitively', () => {
    expect(normaliseContactTagList(['Acme', 'acme', 'ACME'])).toEqual(['Acme'])
  })

  test('caps how many a proposal may add', () => {
    expect(normaliseContactTagList(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b'])
  })

  test('is empty for anything that is not a list', () => {
    expect(normaliseContactTagList(null)).toEqual([])
    expect(normaliseContactTagList('investor')).toEqual([])
  })
})

describe('normaliseContactTagDescription', () => {
  test('collapses a pasted paragraph into one line', () => {
    expect(normaliseContactTagDescription('  People at\n the agency  ')).toBe(
      'People at the agency',
    )
  })

  test('is empty for an empty description, which clears it', () => {
    expect(normaliseContactTagDescription('   ')).toBe('')
  })

  test('rejects a description longer than the limit', () => {
    expect(normaliseContactTagDescription('a'.repeat(240))).toBe(
      'a'.repeat(240),
    )
    expect(normaliseContactTagDescription('a'.repeat(241))).toBeNull()
  })
})

describe('tagDescriptionNeedsRefresh', () => {
  test('never touches text the user wrote', () => {
    expect(
      tagDescriptionNeedsRefresh({
        source: 'user',
        lastChangeAt: 10,
        updatedAt: 5,
        contacts: 3,
      }),
    ).toBe(false)
  })

  test('refreshes its own text once the membership moves past it', () => {
    expect(
      tagDescriptionNeedsRefresh({
        source: 'auto',
        lastChangeAt: 10,
        updatedAt: 5,
        contacts: 3,
      }),
    ).toBe(true)
    expect(
      tagDescriptionNeedsRefresh({
        source: 'auto',
        lastChangeAt: 5,
        updatedAt: 5,
        contacts: 3,
      }),
    ).toBe(false)
  })

  test('drafts text only once someone carries the tag', () => {
    expect(
      tagDescriptionNeedsRefresh({
        source: null,
        lastChangeAt: null,
        updatedAt: null,
        contacts: 0,
      }),
    ).toBe(false)
    expect(
      tagDescriptionNeedsRefresh({
        source: null,
        lastChangeAt: null,
        updatedAt: null,
        contacts: 1,
      }),
    ).toBe(true)
  })
})

describe('sortContactTags', () => {
  test('orders case-insensitively and de-duplicates', () => {
    expect(sortContactTags(['Work', 'acme', 'Bitwise', 'acme'])).toEqual([
      'acme',
      'Bitwise',
      'Work',
    ])
  })

  test('is empty for no tags', () => {
    expect(sortContactTags([])).toEqual([])
  })
})
