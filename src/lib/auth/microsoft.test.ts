/**
 * The Outlook availability gate.
 *
 * The UI reads this to decide whether the Outlook buttons are links or disabled
 * controls, so both directions matter: a false positive sends someone into an
 * OAuth flow that cannot start, and a false negative hides an integration that
 * would have worked.
 */

import { afterEach, describe, expect, test } from 'bun:test'

import { isMicrosoftConfigured } from './microsoft.ts'

const originalId = process.env.MICROSOFT_CLIENT_ID
const originalSecret = process.env.MICROSOFT_CLIENT_SECRET

/** `process.env.X = undefined` writes the string "undefined", so clear instead. */
function setCredentials(id: string | null, secret: string | null) {
  if (id === null) delete process.env.MICROSOFT_CLIENT_ID
  else process.env.MICROSOFT_CLIENT_ID = id

  if (secret === null) delete process.env.MICROSOFT_CLIENT_SECRET
  else process.env.MICROSOFT_CLIENT_SECRET = secret
}

afterEach(() => {
  setCredentials(originalId ?? null, originalSecret ?? null)
})

describe('isMicrosoftConfigured', () => {
  test('is false with no credentials', () => {
    setCredentials(null, null)
    expect(isMicrosoftConfigured()).toBe(false)
  })

  test('is false with only one of the two', () => {
    setCredentials('client-id', null)
    expect(isMicrosoftConfigured()).toBe(false)

    setCredentials(null, 'client-secret')
    expect(isMicrosoftConfigured()).toBe(false)
  })

  test('is true with both', () => {
    setCredentials('client-id', 'client-secret')
    expect(isMicrosoftConfigured()).toBe(true)
  })
})
