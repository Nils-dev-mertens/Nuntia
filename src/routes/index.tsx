/**
 * The inbox route.
 *
 * The loader is a server function, so the Gmail client, the database and
 * googleapis stay on the server — nothing above `service.ts` sees a Gmail type.
 *
 * Sync is not a separate action here. Every load asks for the list, and
 * `loadInbox` decides whether the cursor is stale enough to warrant talking to
 * Gmail. That keeps the freshness policy in one place instead of spread across
 * whichever component happens to trigger it.
 */

import { createServerFn } from '@tanstack/react-start'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'

import { Inbox } from '#/components/inbox'
import { getSession } from '#/lib/auth/index.ts'
import { loadInbox } from '#/lib/gmail/service.ts'

/**
 * How often an open tab re-checks the inbox.
 *
 * Paired with a staleness threshold in `service.ts` that is deliberately longer,
 * so this poll is cheap: it usually re-reads the database and stops.
 */
const REVALIDATE_MS = 2 * 60_000

const fetchInbox = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await getSession()

  if (!session) return { signedIn: false } as const

  return loadInbox(session.accountId)
})

export const Route = createFileRoute('/')({
  loader: () => fetchInbox(),
  component: Home,
})

function Home() {
  const payload = Route.useLoaderData()
  const router = useRouter()

  useEffect(() => {
    // Invalidate re-runs the loader, which re-runs the server function, which
    // re-reads the database and syncs only if the cursor has gone stale.
    const timer = setInterval(() => {
      void router.invalidate()
    }, REVALIDATE_MS)

    // A backgrounded tab's timer is throttled or paused, so a tab left open in
    // another window would otherwise come back minutes stale.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void router.invalidate()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [router])

  return <Inbox payload={payload} />
}