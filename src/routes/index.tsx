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

/**
 * How often an open tab re-checks while a sync is still running.
 *
 * A first backfill writes threads as it goes, so a fast poll is what turns the
 * progress banner into mail appearing in the list. It only applies while a sync
 * is in flight; once it finishes the slow cadence takes over again.
 */
const SYNCING_REVALIDATE_MS = 3_000

const fetchInbox = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await getSession()

  if (!session) return { signedIn: false } as const

  // Accounts are global to the install, so the loader does not name one: every
  // connected mailbox is read and merged into a single list.
  return loadInbox()
})

/**
 * Rebuild the inbox from Gmail on demand.
 *
 * The escape hatch for the failure incremental sync cannot fix on its own: a
 * thread whose save failed while the cursor still advanced past it. Passing
 * `full` turns the run into a backfill, which re-lists threads rather than
 * trusting the cursor.
 */
const resyncInbox = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    try {
      const payload = await loadInbox({ force: true, full: true })
      if (!payload.signedIn) return { error: 'No mailbox is connected.' }
      // A failed sync does not throw — it is reported on the payload.
      return { error: payload.syncError }
    } catch (error) {
      console.error('[resync] failed:', error)
      return {
        error: error instanceof Error ? error.message : 'Re-sync failed.',
      }
    }
  },
)

export const Route = createFileRoute('/')({
  loader: () => fetchInbox(),
  component: Home,
})

function Home() {
  const payload = Route.useLoaderData()
  const router = useRouter()

  // A boolean rather than the list itself: the effect below should restart when
  // a sync starts or ends, not on every progress tick within one.
  const syncing = payload.signedIn && payload.syncing.length > 0

  useEffect(() => {
    // Invalidate re-runs the loader, which re-runs the server function, which
    // re-reads the database and syncs only if the cursor has gone stale.
    const timer = setInterval(
      () => {
        void router.invalidate()
      },
      syncing ? SYNCING_REVALIDATE_MS : REVALIDATE_MS,
    )

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
  }, [router, syncing])

  return (
    <Inbox
      payload={payload}
      onResync={async () => {
        const result = await resyncInbox()
        // The action has already written whatever it could, so a refresh is
        // what makes the list reflect it.
        if (!result.error) await router.invalidate()
        return result
      }}
    />
  )
}
