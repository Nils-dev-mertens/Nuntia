/**
 * Sign out.
 *
 * Clears the session cookie. The stored account and its synced mail stay on
 * disk — removing them is a separate, explicit action, since a user signing out
 * of a mail client does not expect their local cache to be wiped.
 */

import { createFileRoute } from '@tanstack/react-router'
import { deleteCookie } from '@tanstack/react-start/server'

export const Route = createFileRoute('/auth/logout')({
  server: {
    handlers: {
      GET: async (): Promise<Response> => {
        deleteCookie('lumen_session', { path: '/' })

        return new Response(null, {
          status: 302,
          headers: { location: '/' },
        })
      },
    },
  },
})