/**
 * Gmail push notifications.
 *
 * Pub/Sub delivers a POST here when a watched mailbox changes. The handler does
 * three things and nothing else: check the shared token, resolve the address to
 * a connected mailbox, and start that mailbox's sync in the background.
 *
 * It never waits for the sync — Pub/Sub treats a slow or failed response as a
 * reason to redeliver, and a redelivery that re-ran the whole inbox would be
 * worse than the poll it replaces. Everything unrecognised is acknowledged, so a
 * notification for a mailbox this install does not hold cannot become a retry
 * loop.
 */

import { timingSafeEqual } from 'node:crypto'

import { createFileRoute } from '@tanstack/react-router'

import { startBackgroundSync } from '#/lib/gmail/service.ts'
import { pushToken, resolveGmailPushTarget } from '#/lib/mailbox/push.ts'

function textResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

/** Constant-time comparison that tolerates different lengths. */
function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export const Route = createFileRoute('/webhooks/gmail')({
  server: {
    handlers: {
      /**
       * Explicit `Response` rather than a thrown error: this endpoint is called
       * by a machine, and the status is the whole message.
       */
      POST: async ({ request }): Promise<Response> => {
        const expected = pushToken()
        if (!expected) {
          return textResponse(
            'Push is not configured: set GOOGLE_PUBSUB_TOPIC and GMAIL_PUSH_TOKEN.',
            503,
          )
        }

        const supplied =
          new URL(request.url).searchParams.get('token') ??
          request.headers.get('x-lumen-push-token') ??
          ''
        if (!tokensMatch(supplied, expected)) {
          return textResponse('Forbidden', 403)
        }

        let payload: unknown
        try {
          payload = await request.json()
        } catch {
          return textResponse('Expected a JSON body', 400)
        }

        const target = await resolveGmailPushTarget(payload)
        if (!target) return new Response(null, { status: 204 })

        startBackgroundSync(target.userId, target.accountId, target.email)
        return new Response(null, { status: 204 })
      },
    },
  },
})
