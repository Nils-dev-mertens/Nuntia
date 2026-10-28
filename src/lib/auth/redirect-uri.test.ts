/**
 * Where each provider sends the browser back.
 *
 * The failure this pins down is a deployed install returning to
 * `localhost:3000` after consent: the callback used to be a hard-coded localhost
 * default, so an operator who set `LUMEN_APP_URL` (the one origin they already
 * configure) still landed on their own machine. Both callbacks now follow that
 * one variable, and a provider-specific variable still wins.
 */

import { afterEach, describe, expect, test } from 'bun:test'

import { redirectUri as googleRedirectUri } from '#/lib/auth/google.ts'
import { redirectUri as microsoftRedirectUri } from '#/lib/auth/microsoft.ts'

const saved = {
  app: process.env.LUMEN_APP_URL,
  google: process.env.GOOGLE_REDIRECT_URI,
  microsoft: process.env.MICROSOFT_REDIRECT_URI,
}

afterEach(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  restore('LUMEN_APP_URL', saved.app)
  restore('GOOGLE_REDIRECT_URI', saved.google)
  restore('MICROSOFT_REDIRECT_URI', saved.microsoft)
})

describe('OAuth redirect URIs', () => {
  test('follow LUMEN_APP_URL, so a deploy does not come back to localhost', () => {
    process.env.LUMEN_APP_URL = 'https://mail.example.com'
    delete process.env.GOOGLE_REDIRECT_URI
    delete process.env.MICROSOFT_REDIRECT_URI

    expect(googleRedirectUri()).toBe(
      'https://mail.example.com/auth/google/callback',
    )
    expect(microsoftRedirectUri()).toBe(
      'https://mail.example.com/auth/microsoft/callback',
    )
  })

  test('ignore a trailing slash on the configured origin', () => {
    process.env.LUMEN_APP_URL = 'https://mail.example.com/'
    delete process.env.GOOGLE_REDIRECT_URI

    expect(googleRedirectUri()).toBe(
      'https://mail.example.com/auth/google/callback',
    )
  })

  test('fall back to the development origin when nothing is configured', () => {
    delete process.env.LUMEN_APP_URL
    delete process.env.GOOGLE_REDIRECT_URI
    delete process.env.MICROSOFT_REDIRECT_URI

    expect(googleRedirectUri()).toBe(
      'http://localhost:3000/auth/google/callback',
    )
    expect(microsoftRedirectUri()).toBe(
      'http://localhost:3000/auth/microsoft/callback',
    )
  })

  test('let the provider-specific variable win', () => {
    process.env.LUMEN_APP_URL = 'https://mail.example.com'
    process.env.GOOGLE_REDIRECT_URI = 'https://auth.example.com/google'
    process.env.MICROSOFT_REDIRECT_URI = 'https://auth.example.com/microsoft'

    expect(googleRedirectUri()).toBe('https://auth.example.com/google')
    expect(microsoftRedirectUri()).toBe('https://auth.example.com/microsoft')
  })

  test('treat an empty provider-specific variable as unset', () => {
    // `.env.example` ships these as `""`; an empty string must not become the
    // redirect_uri, which Google would reject with a redirect_uri_mismatch.
    process.env.LUMEN_APP_URL = 'https://mail.example.com'
    process.env.GOOGLE_REDIRECT_URI = ''
    process.env.MICROSOFT_REDIRECT_URI = '   '

    expect(googleRedirectUri()).toBe(
      'https://mail.example.com/auth/google/callback',
    )
    expect(microsoftRedirectUri()).toBe(
      'https://mail.example.com/auth/microsoft/callback',
    )
  })
})
