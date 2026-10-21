/**
 * Sign out.
 *
 * Deletes this device's session row and clears the cookie. The mailboxes and
 * their synced mail stay on disk — removing them is a separate, explicit action
 * from Settings, since signing out of a mail client does not mean wiping the
 * local cache.
 *
 * Only *this* device is signed out. The other rows are the user's other devices,
 * and a link that silently signed them all out would be the wrong default;
 * "sign out everywhere" is a button in Settings instead.
 */

import { createFileRoute } from '@tanstack/react-router'

import { destroySession } from '#/lib/auth/index.ts'

export const Route = createFileRoute('/auth/logout')({
  server: {
    handlers: {
      GET: async (): Promise<Response> => {
        await destroySession()

        return new Response(null, {
          status: 302,
          headers: { location: '/sign-in' },
        })
      },
    },
  },
})
