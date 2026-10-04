import { describe, expect, test } from 'bun:test'

import { GmailAuthError, GmailRateLimitError } from './client.ts'
import { needsGoogleLogin } from './service.ts'

describe('needsGoogleLogin', () => {
  test('is true for a revoked or rejected grant', () => {
    expect(needsGoogleLogin(new GmailAuthError('revoked'))).toBe(true)
  })

  test('is true when the stored token can no longer be decrypted', () => {
    expect(
      needsGoogleLogin(
        new Error('Stored refresh token could not be decrypted'),
      ),
    ).toBe(true)
  })

  test('is false for failures that a retry can fix', () => {
    expect(needsGoogleLogin(new GmailRateLimitError('slow down'))).toBe(false)
    expect(needsGoogleLogin(new Error('Gmail request failed (503)'))).toBe(
      false,
    )
    expect(needsGoogleLogin(undefined)).toBe(false)
  })
})
