/**
 * Contact enrichment is pure by design — no database, no network — so the rules
 * that decide what a row shows are testable on their own. The one external
 * surface, the Gravatar URL, is asserted by its hash rather than by fetching it.
 */

import { describe, expect, test } from 'bun:test'

import {
  enrichParticipants,
  gravatarUrl,
  initialsOf,
  normaliseContactEmail,
} from './index.ts'

describe('initialsOf', () => {
  test('uses the first and last word of a name', () => {
    expect(initialsOf('Nils de Vries', 'n@example.com')).toBe('NV')
    expect(initialsOf('  Alice  ', 'alice@example.com')).toBe('A')
  })

  test('falls back to the address when there is no name', () => {
    expect(initialsOf(null, 'bob@example.com')).toBe('B')
    expect(initialsOf('   ', 'bob@example.com')).toBe('B')
  })

  test('never returns an empty string, even for a useless address', () => {
    expect(initialsOf(null, '')).toBe('?')
  })
})

describe('gravatarUrl', () => {
  test('is the MD5 of the lowercased, trimmed address', () => {
    // MD5 of 'alice@example.com' — the value Gravatar itself hashes.
    expect(gravatarUrl('  Alice@Example.com ')).toBe(
      'https://www.gravatar.com/avatar/c160f8cc69a4f0bf2b0362752353d060?d=404&s=64',
    )
  })

  test('asks for 404 rather than a default image, so initials can show', () => {
    expect(gravatarUrl('bob@example.com')).toContain('d=404')
  })
})

describe('enrichParticipants', () => {
  const participants = [
    { name: 'Alice Anders', email: 'alice@example.com' },
    { name: null, email: 'bob@example.com' },
  ]

  test('keeps a participant name and fills in a learned one', () => {
    const enriched = enrichParticipants(
      participants,
      new Map([['bob@example.com', 'Bob Baker']]),
      false,
    )

    expect(enriched[0]?.name).toBe('Alice Anders')
    expect(enriched[1]?.name).toBe('Bob Baker')
    expect(enriched.map((p) => p.initials)).toEqual(['AA', 'BB'])
  })

  test('leaves avatars off unless Gravatar is enabled', () => {
    const enriched = enrichParticipants(participants, new Map(), false)
    expect(enriched.every((p) => p.avatarUrl === null)).toBe(true)

    const withAvatars = enrichParticipants(participants, new Map(), true)
    expect(withAvatars[0]?.avatarUrl).toContain('www.gravatar.com')
    expect(withAvatars[1]?.avatarUrl).toContain('www.gravatar.com')
  })

  test('matches a learned name regardless of the address casing', () => {
    const enriched = enrichParticipants(
      [{ name: null, email: 'BOB@example.com' }],
      new Map([['bob@example.com', 'Bob Baker']]),
      false,
    )

    expect(enriched[0]?.name).toBe('Bob Baker')
  })

  test('normalises an address the way the table stores it', () => {
    expect(normaliseContactEmail(' Alice@Example.com ')).toBe(
      'alice@example.com',
    )
  })
})
