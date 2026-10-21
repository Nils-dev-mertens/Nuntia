import { describe, expect, test } from 'bun:test'

import { GmailAuthError, GmailRateLimitError } from '#/lib/gmail/client.ts'
import { describeActionFailure, needsReconnect } from '#/lib/gmail/service.ts'

describe('needsReconnect', () => {
  test('is true for a revoked or rejected grant', () => {
    expect(needsReconnect(new GmailAuthError('revoked'))).toBe(true)
  })

  test('is true when the stored token can no longer be decrypted', () => {
    expect(
      needsReconnect(new Error('Stored refresh token could not be decrypted')),
    ).toBe(true)
  })

  test('is false for failures that a retry can fix', () => {
    expect(needsReconnect(new GmailRateLimitError('slow down'))).toBe(false)
    expect(needsReconnect(new Error('Gmail request failed (503)'))).toBe(false)
    expect(needsReconnect(undefined)).toBe(false)
  })
})

describe('describeActionFailure', () => {
  test('drops the raw API text and flags auth when the grant is rejected', () => {
    const result = describeActionFailure(
      new GmailAuthError('Gmail rejected the stored credentials.'),
      'Could not send the reply.',
    )

    expect(result.authRequired).toBe(true)
    expect(result.error).not.toContain('Gmail rejected the stored credentials')
    expect(result.error).toContain('no longer accepts')
  })

  test('treats an undecryptable stored token as needing a login too', () => {
    const result = describeActionFailure(
      new Error('Stored refresh token could not be decrypted'),
      'Could not send the reply.',
    )

    expect(result.authRequired).toBe(true)
  })

  test('keeps the message and stays retryable for any other failure', () => {
    expect(
      describeActionFailure(
        new GmailRateLimitError('slow down'),
        'Could not send the reply.',
      ),
    ).toEqual({ error: 'slow down', authRequired: false })
  })

  test('falls back when the thrown value is not an Error', () => {
    expect(describeActionFailure('boom', 'Could not send the reply.')).toEqual({
      error: 'Could not send the reply.',
      authRequired: false,
    })
  })
})
