import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { decrypt, encrypt, tryDecrypt } from './crypto.ts'

/** A fixed 32-byte key (64 hex chars) so tests are deterministic. */
const TEST_KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)

let originalKey: string | undefined

beforeEach(() => {
  originalKey = process.env.TOKEN_ENCRYPTION_KEY
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY
})

afterEach(() => {
  if (originalKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY
  else process.env.TOKEN_ENCRYPTION_KEY = originalKey
})

describe('encrypt/decrypt', () => {
  test('round-trips a refresh token', () => {
    const token = 'ya29.a0AfH6SMBxYzZ1234567890'
    expect(decrypt(encrypt(token))).toBe(token)
  })

  test('round-trips unicode and newlines', () => {
    const token = 'tokén-with-ünicode\nand\ttabs'
    expect(decrypt(encrypt(token))).toBe(token)
  })

  test('round-trips an empty string', () => {
    expect(decrypt(encrypt(''))).toBe('')
  })

  test('produces a versioned envelope', () => {
    expect(encrypt('x').startsWith('v1:')).toBe(true)
  })

  test('never emits the plaintext in the ciphertext', () => {
    const token = 'super-secret-refresh-token'
    const envelope = encrypt(token)
    expect(envelope).not.toContain(token)
  })

  test('uses a fresh IV each time, so identical tokens differ', () => {
    const a = encrypt('same-token')
    const b = encrypt('same-token')

    expect(a).not.toBe(b)
    // Both still decrypt correctly.
    expect(decrypt(a)).toBe('same-token')
    expect(decrypt(b)).toBe('same-token')
  })
})

describe('tamper detection', () => {
  test('rejects a modified ciphertext', () => {
    const envelope = encrypt('secret')
    const parts = envelope.split(':')

    // Flip a character in the ciphertext segment.
    const ct = parts[3]
    parts[3] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1)

    expect(() => decrypt(parts.join(':'))).toThrow()
  })

  test('rejects a modified auth tag', () => {
    const parts = encrypt('secret').split(':')
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1)

    expect(() => decrypt(parts.join(':'))).toThrow()
  })

  test('rejects a malformed envelope', () => {
    expect(() => decrypt('not-an-envelope')).toThrow()
  })

  test('rejects an unknown envelope version', () => {
    const parts = encrypt('secret').split(':')
    parts[0] = 'v99'
    expect(() => decrypt(parts.join(':'))).toThrow(/version/i)
  })

  test('rejects a token encrypted under a different key', () => {
    const envelope = encrypt('secret')
    process.env.TOKEN_ENCRYPTION_KEY = OTHER_KEY

    expect(() => decrypt(envelope)).toThrow()
  })
})

describe('tryDecrypt', () => {
  test('returns null instead of throwing on bad data', () => {
    expect(tryDecrypt('garbage')).toBeNull()
    expect(tryDecrypt('')).toBeNull()
    expect(tryDecrypt(null)).toBeNull()
    expect(tryDecrypt(undefined)).toBeNull()
  })

  test('returns the plaintext for valid data', () => {
    expect(tryDecrypt(encrypt('ok'))).toBe('ok')
  })
})

describe('key validation', () => {
  test('throws a helpful error when no key is set', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY
    expect(() => encrypt('x')).toThrow(/TOKEN_ENCRYPTION_KEY/)
  })

  test('rejects a key of the wrong length', () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'too-short'
    expect(() => encrypt('x')).toThrow(/32 bytes/)
  })

  test('accepts a base64 key', () => {
    // 32 bytes as base64.
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
    expect(decrypt(encrypt('x'))).toBe('x')
  })
})