/**
 * Google connect callback.
 *
 * Verifies CSRF state, exchanges the code for tokens, encrypts the refresh token
 * before it reaches the database, and attaches the mailbox to the *signed-in
 * user*. Connecting a mailbox is not signing in: the session already exists, and
 * this only adds a mailbox to whoever owns it.
 *
 * Every failure path answers with a reason rather than a blank screen — an OAuth
 * failure with no explanation is miserable to debug.
 */

import { createFileRoute } from '@tanstack/react-router'
import { getCookie, deleteCookie } from '@tanstack/react-start/server'

import {
  exchangeCode,
  fetchProfile,
  getSession,
  readState,
  readVerifier,
  upsertAccount,
} from '#/lib/auth/index.ts'

/** Remove the short-lived OAuth cookies now the flow is done. */
function clearOAuthCookies(): void {
  for (const name of ['lumen_oauth_state', 'lumen_oauth_verifier']) {
    deleteCookie(name, { path: '/' })
  }
}

function fail(reason: string, status = 400): Response {
  clearOAuthCookies()
  return new Response(`Sign-in failed: ${reason}`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

export const Route = createFileRoute('/auth/google/callback')({
  server: {
    handlers: {
      GET: async ({ request }): Promise<Response> => {
        const url = new URL(request.url)
        const error = url.searchParams.get('error')

        // The user declined, or Google refused.
        if (error) {
          return fail(url.searchParams.get('error_description') ?? error, 400)
        }

        const code = url.searchParams.get('code')
        if (!code) return fail('No authorization code was returned.')

        const state = url.searchParams.get('state')
        const expectedState = readState(getCookie)

        // CSRF check: the state we issued must come back unchanged.
        if (!state || !expectedState || state !== expectedState) {
          return fail('Request state did not match. Please try again.', 403)
        }

        const verifier = readVerifier(getCookie)
        if (!verifier) {
          return fail('Sign-in session expired. Please try again.', 400)
        }

        // The mailbox belongs to whoever is signed in. Checked here rather than
        // before the redirect because the session cookie is what the callback
        // actually writes against, and it is the only place that knows the
        // connection completed.
        const session = await getSession()
        if (!session) {
          return fail('Sign in to Nuntia before connecting a mailbox.', 401)
        }

        try {
          const tokens = await exchangeCode(code, verifier)

          if (!tokens.accessToken) {
            return fail('Google did not return an access token.')
          }

          const profile = await fetchProfile(tokens.accessToken)

          // Encryption happens inside upsertAccount — the plaintext token does
          // not reach the database.
          await upsertAccount({
            userId: session.userId,
            email: profile.email,
            provider: 'google',
            refreshToken: tokens.refreshToken,
            scopes: tokens.scopes,
          })

          clearOAuthCookies()

          // Plain Response for the same reason as the login route: keeps the
          // handler's return type free of the router's route-path generics.
          return new Response(null, {
            status: 302,
            headers: { location: '/' },
          })
        } catch (err) {
          // Log server-side, show a generic message to the user. OAuth errors
          // can contain token material and must not be echoed back.
          console.error('[auth] callback failed:', err)
          return fail(
            'Could not complete sign-in. Check the server logs for details.',
            500,
          )
        }
      },
    },
  },
})
