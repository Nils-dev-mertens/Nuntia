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
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'

import { Inbox } from '#/components/inbox'
import { getSession } from '#/lib/auth/index.ts'
import {
  dismissForm,
  listOpenFormsForUser,
  markFormShown,
} from '#/lib/forms/repository.ts'
import { loadInbox } from '#/lib/gmail/service.ts'
import type { ConversationSummary } from '#/lib/gmail/service.ts'

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

  // Scoped to the signed-in user: every mailbox they own is read and merged into
  // one list, and no other account's mail is reachable from here.
  return loadInbox(session.userId)
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
      const payload = await loadInbox(session.userId, {
        force: true,
        full: true,
      })
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

/**
 * Search the mail this user's mailboxes have already synced.
 *
 * Server-side rather than filtering the rendered list: the ten-per-section view
 * deliberately hides most rows, so a search has to be able to match mail the
 * page is not showing. It reads the database only — no provider call, no
 * re-decision — so typing stays cheap.
 */
const searchInbox = createServerFn({ method: 'GET' })
  .validator((data: { query: string }) => data)
  .handler(
    async ({
      data,
    }): Promise<{
      conversations: ConversationSummary[]
      error: string | null
    }> => {
      const session = await getSession()
      if (!session) {
        return { conversations: [], error: 'You are not signed in.' }
      }

      const query =
        typeof data.query === 'string' ? data.query.trim().slice(0, 200) : ''
      if (!query) return { conversations: [], error: null }

      try {
        const payload = await loadInbox(session.userId, { search: query })
        if (!payload.signedIn) {
          return { conversations: [], error: 'No mailbox is connected.' }
        }
        return { conversations: payload.conversations, error: null }
      } catch (error) {
        console.error('[search] failed:', error)
        return {
          conversations: [],
          error: 'Search failed. Try again in a moment.',
        }
      }
    },
  )

/**
 * The one open form the inbox promotes, plus how many are open overall.
 *
 * Returning the prompt marks it shown, which is the denominator the response
 * rate is measured against — a form nobody saw and a form everybody ignored are
 * different facts. The write is idempotent, so the two-minute revalidation does
 * not inflate it.
 */
const fetchFormPrompt = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await getSession()
  if (!session) return { signedIn: false } as const

  const open = await listOpenFormsForUser(session.userId)
  const promoted =
    open.find((form) => !form.dismissed && !form.submitted) ?? null
  if (promoted) await markFormShown(promoted.id, session.userId)

  return {
    signedIn: true,
    // Answered forms stay listed under Questions so an answer can be edited,
    // which is also why the link survives after every form is answered.
    count: open.length,
    promoted: promoted
      ? {
          id: promoted.id,
          title: promoted.title,
          description: promoted.description,
          questionCount: promoted.questionCount,
        }
      : null,
  } as const
})

const dismissFormPrompt = createServerFn({ method: 'POST' })
  .validator((data: { formId: string }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    const result = await dismissForm(data.formId, session.userId)
    return { error: result.ok ? null : result.error }
  })

export const Route = createFileRoute('/')({
  // Signed out is a redirect rather than a branch the inbox renders: without a
  // user there is nobody whose mail this page could possibly show.
  loader: async () => {
    const [payload, prompts] = await Promise.all([
      fetchInbox(),
      fetchFormPrompt(),
    ])

    if (!payload.signedIn) throw redirect({ to: '/sign-in' })

    return {
      ...payload,
      formPrompt: prompts.signedIn ? prompts.promoted : null,
      openFormCount: prompts.signedIn ? prompts.count : 0,
    }
  },
  component: Home,
})

function Home() {
  const { formPrompt, openFormCount, ...payload } = Route.useLoaderData()
  const router = useRouter()

  // A boolean rather than the list itself: the effect below should restart when
  // a sync starts or ends, not on every progress tick within one. Signed out is
  // not a case here — the loader redirects it to the sign-in page.
  const syncing = payload.syncing.length > 0

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
      formPrompt={formPrompt}
      openFormCount={openFormCount}
      onResync={async () => {
        const result = await resyncInbox()
        // The action has already written whatever it could, so a refresh is
        // what makes the list reflect it.
        if (!result.error) await router.invalidate()
        return result
      }}
      onDismissForm={async (formId) => {
        const result = await dismissFormPrompt({ data: { formId } })
        if (!result.error) await router.invalidate()
        return result
      }}
      onSearch={(query) => searchInbox({ data: { query } })}
    />
  )
}
