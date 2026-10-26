/**
 * Invite codes.
 *
 * The properties that matter are transcription properties: a code has to
 * survive being read aloud, retyped with a dash in the wrong place, and typed
 * with `O` where the alphabet has a zero. Everything here is about that.
 */

import { describe, expect, test } from 'bun:test'

import { readFileSync } from 'node:fs'

import { CODE_LENGTH, formatCode, normaliseCode } from './codes.ts'
import { generateCode, hashCode } from './secrets.ts'

describe('codes.ts', () => {
  test('stays browser-safe: no node: imports', () => {
    // The code-entry page imports this module for `normaliseCode`, which puts it
    // in the client bundle. A `node:` import here is externalised by Vite and
    // throws at runtime the first time someone opens the form — a build that
    // passes and a page that dies.
    const source = readFileSync(
      new URL('./codes.ts', import.meta.url),
      'utf8',
    )

    expect(source).not.toMatch(/from ['"]node:/)
  })
})

describe('generateCode', () => {
  test('is the documented length once separators are removed', () => {
    const code = generateCode()
    expect(normaliseCode(code)).toHaveLength(CODE_LENGTH)
  })

  test('avoids the characters people misread', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(normaliseCode(generateCode())).not.toMatch(/[ILOU]/)
    }
  })

  test('is grouped for display', () => {
    expect(formatCode(generateCode())).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
  })

  test('does not repeat', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateCode()))
    expect(seen.size).toBe(100)
  })
})

describe('normaliseCode', () => {
  test('forgives case, spaces and dashes', () => {
    expect(normaliseCode(' a1b2-c3d4 e5f6 ')).toBe('A1B2C3D4E5F6')
  })

  test('maps the letters the alphabet omits', () => {
    // O looks like zero; I and L look like one. These are the three mistakes
    // the alphabet invites, so they are corrected rather than rejected.
    expect(normaliseCode('OIL000000000')).toBe('011000000000')
  })

  test('refuses the wrong length', () => {
    expect(normaliseCode('ABC')).toBeNull()
    expect(normaliseCode('A1B2C3D4E5F6G7')).toBeNull()
  })

  test('refuses characters outside the alphabet', () => {
    expect(normaliseCode('A1B2C3D4E5F!')).toBeNull()
  })
})

describe('hashCode', () => {
  test('is stable across every accepted spelling', () => {
    const canonical = 'A1B2C3D4E5F6'
    expect(hashCode('a1b2-c3d4-e5f6')).toBe(hashCode(canonical))
    expect(hashCode('A1B2 C3D4 E5F6')).toBe(hashCode(canonical))
  })

  test('is a sha-256 hex digest, never the code', () => {
    const code = 'A1B2C3D4E5F6'
    const digest = hashCode(code)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).not.toContain(code)
  })

  test('differs between codes', () => {
    expect(hashCode('A1B2C3D4E5F6')).not.toBe(hashCode('A1B2C3D4E5F7'))
  })
})
