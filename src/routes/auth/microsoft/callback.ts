/**
 * Microsoft connect callback.
 *
 * Verifies the CSRF state, exchanges the code, fetches the account's address and
 * stores the refresh token encrypted — attached to the signed-in user, exactly
 * as the Google callback does.
 *
 * Failures answer with a reason: an OAuth error with no explanation is miserable
 * to debug, and the user cannot fix a state mismatch by retrying a stale page.
 */

import { createFileRoute } from '@tanstack/react-router'
import { deleteCookie, getCookie } from '@tanstack/react-start/server'

import {
  exchangeCode,
  fetchProfile,
  readState,
  readVerifier,
} from '#/lib/auth/microsoft.ts'
import { clearOAuthCookies } from '#/lib/auth/oauth.ts'
import { getSession, upsertAccount } from '#/lib/auth/index.ts'

function fail(reason: string, status = 400): Response {
  clearOAuthCookies(deleteCookie)
  return new Response(`Sign-in failed: ${reason}`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

export const Route = createFileRoute('/auth/microsoft/callback')({
  server: {
    handlers: {
      GET: async ({ request }): Promise<Response> => {
        const url = new URL(request.url)
        const error = url.searchParams.get('error')

        if (error) {
          return fail(url.searchParams.get('error_description') ?? error, 400)
        }

        const code = url.searchParams.get('code')
        if (!code) return fail('No authorization code was returned.')

        const state = url.searchParams.get('state')
        const expectedState = readState(getCookie)

        if (!state || !expectedState || state !== expectedState) {
          return fail('Request state did not match. Please try again.', 403)
        }

        const verifier = readVerifier(getCookie)
        if (!verifier) {
          return fail('Sign-in session expired. Please try again.', 400)
        }

        // The mailbox belongs to whoever is signed in, and this is the only
        // place that knows the connection completed.
        const session = await getSession()
        if (!session) {
          return fail('Sign in to Lumen before connecting a mailbox.', 401)
        }

        try {
          const tokens = await exchangeCode(code, verifier)

          const profile = await fetchProfile(tokens.accessToken)

          // Encryption happens inside upsertAccount; the plaintext token never
          // reaches the database.
          await upsertAccount({
            userId: session.userId,
            email: profile.email,
            provider: 'microsoft',
            refreshToken: tokens.refreshToken,
            scopes: tokens.scopes,
          })

          clearOAuthCookies(deleteCookie)

          return new Response(null, {
            status: 302,
            headers: { location: '/' },
          })
        } catch (err) {
          console.error('[auth] microsoft callback failed:', err)
          return fail(
            'Could not complete Outlook sign-in. Check the server logs for details.',
            500,
          )
        }
      },
    },
  },
})
