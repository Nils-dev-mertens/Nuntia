/**
 * Start the Microsoft OAuth flow.
 *
 * The same shape as the Google route: stash `state` and the PKCE verifier in
 * short-lived cookies, then redirect to the consent screen. A missing client id
 * is reported as a plain sentence rather than a bare 500, because "Outlook is
 * not configured" is a setup fact, not a crash.
 *
 * Signed in first, for the same reason as Google: the callback attaches the
 * mailbox to the session's user.
 */

import { createFileRoute } from '@tanstack/react-router'
import { setCookie } from '@tanstack/react-start/server'

import { buildAuthUrl } from '#/lib/auth/microsoft.ts'
import { getSession } from '#/lib/auth/index.ts'

export const Route = createFileRoute('/auth/microsoft/')({
  server: {
    handlers: {
      GET: async (): Promise<Response> => {
        if (!(await getSession())) {
          return new Response(null, {
            status: 302,
            headers: { location: '/sign-in' },
          })
        }

        try {
          const url = await buildAuthUrl((name, value, opts) =>
            setCookie(name, value, opts),
          )

          return new Response(null, {
            status: 302,
            headers: { location: url },
          })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to start sign-in'

          return new Response(`Outlook is not configured: ${message}`, {
            status: 500,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          })
        }
      },
    },
  },
})
