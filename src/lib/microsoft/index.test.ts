import { describe, expect, test } from 'bun:test'

import { encrypt, tryDecrypt } from '#/lib/auth/crypto.ts'

import { createMicrosoftMailbox } from './index.ts'

// The crypto layer refuses to run without a key, and the suite does not load
// `.env.local` for it. A fixed test value keeps this file self-contained.
process.env.TOKEN_ENCRYPTION_KEY = '11'.repeat(32)
process.env.MICROSOFT_CLIENT_ID = 'client'
process.env.MICROSOFT_CLIENT_SECRET = 'secret'
process.env.MICROSOFT_TENANT = 'common'

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createMicrosoftMailbox', () => {
  test('refreshes the access token once, then reuses it', async () => {
    let tokenRequests = 0
    const authHeaders: string[] = []

    const fetchImpl = (async (
      input: RequestInfo | URL,
      init: RequestInit = {},
    ) => {
      const url = String(input)

      if (url.includes('login.microsoftonline.com')) {
        tokenRequests++
        return json(200, {
          access_token: 'access-1',
          refresh_token: 'refresh-2',
          expires_in: 3600,
        })
      }

      authHeaders.push(new Headers(init.headers).get('authorization') ?? '')
      return json(200, { value: [] })
    }) as typeof fetch

    const rotated: string[] = []
    const client = createMicrosoftMailbox({
      refreshTokenEnvelope: encrypt('refresh-1'),
      email: 'me@outlook.com',
      fetchImpl,
      onRefreshToken: async (envelope) => {
        rotated.push(envelope)
      },
    })

    expect(await client.getEmailAddress()).toBe('me@outlook.com')

    await client.listThreads({})
    await client.listThreads({})

    // One token exchange for the whole client, and every Graph call carries it.
    expect(tokenRequests).toBe(1)
    expect(authHeaders).toEqual(['Bearer access-1', 'Bearer access-1'])

    // Microsoft rotated the refresh token; the new ciphertext is handed back to
    // be persisted, and decrypts to the value Microsoft sent.
    expect(rotated).toHaveLength(1)
    expect(tryDecrypt(rotated[0])).toBe('refresh-2')
  })

  test('an unreadable stored token fails before any network call', () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return json(200, {})
    }) as unknown as typeof fetch

    expect(() =>
      createMicrosoftMailbox({
        refreshTokenEnvelope: 'not-a-real-envelope',
        email: 'me@outlook.com',
        fetchImpl,
      }),
    ).toThrow(/could not be decrypted/)
    expect(called).toBe(false)
  })
})
