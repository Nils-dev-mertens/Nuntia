/**
 * Start the Google OAuth flow.
 *
 * Stashes `state` (CSRF) and the PKCE verifier in short-lived cookies, then
 * redirects to Google's consent screen. Nothing secret is persisted here — the
 * verifier is only useful together with the client secret we hold server-side.
 */

import { createFileRoute } from '@tanstack/react-router'
import { setCookie } from '@tanstack/react-start/server'

import { buildAuthUrl } from '#/lib/auth/index.ts'

export const Route = createFileRoute('/auth/google/')({
  server: {
    handlers: {
      // Returns a plain Response rather than `redirect()`: the target is an
      // external Google URL, and `redirect({ to })` expects an internal route
      // path, which makes TypeScript infer this handler circularly.
      GET: async (): Promise<Response> => {
        try {
          const url = await buildAuthUrl((name, value, opts) =>
            setCookie(name, value, opts),
          )

          return new Response(null, {
            status: 302,
            headers: { location: url },
          })
        } catch (error) {
          // Most likely a missing client id/secret in .env.local. Surfacing the
          // message here beats a bare 500.
          const message =
            error instanceof Error ? error.message : 'Failed to start sign-in'

          return new Response(`OAuth is not configured: ${message}`, {
            status: 500,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          })
        }
      },
    },
  },
})