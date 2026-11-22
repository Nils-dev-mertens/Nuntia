/**
 * Liveness for the container supervisor.
 *
 * The server awaits `initDatabase()` before routing a request, so answering
 * here also means migrations and the one-off repairs have finished. Compose
 * uses that to hold the MCP container back until the database is ready.
 *
 * Unauthenticated and static on purpose: it reveals nothing about the mailbox.
 */

import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/healthz')({
  server: {
    handlers: {
      GET: (): Response =>
        new Response(JSON.stringify({ ok: true }), {
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
        }),
    },
  },
})
