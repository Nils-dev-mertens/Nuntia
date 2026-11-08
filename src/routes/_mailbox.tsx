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
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'

import { AppShell } from '#/components/app-shell.tsx'
import type { ShellSection } from '#/components/app-shell.tsx'
import { ComposeOverlay } from '#/components/compose-overlay.tsx'
import { QuestionsOverlay } from '#/components/questions-overlay.tsx'
import { Inbox } from '#/components/inbox'
import type { MailPreview } from '#/components/inbox'
import { DONE_GROUP, STATE_META, STATE_ORDER } from '#/lib/conversation-state'
import {
  loadComposeState,
  loadStylePreview,
  sendMessageAction,
} from '#/lib/mailbox/compose-actions.ts'
import { getSession } from '#/lib/auth/index.ts'
import { isMicrosoftConfigured } from '#/lib/auth/microsoft.ts'
import {
  dismissForm,
  listOpenFormsForUser,
  markFormShown,
} from '#/lib/forms/repository.ts'
import {
  applyUserStateOverride,
  loadConversation,
  loadInbox,
  setConversationDone,
  setConversationOrganizationGroup,
  setConversationUnread,
} from '#/lib/gmail/service.ts'
import type { ConversationSummary } from '#/lib/gmail/service.ts'
import { resolveInboxOrder } from '#/lib/organization/inbox-order.ts'
import { listOrganizationLabels } from '#/lib/organization/store.ts'
import { savePreferences } from '#/lib/settings/preferences.ts'
import { CONVERSATION_STATES } from '#/db/schema.ts'
import type { ConversationState } from '#/db/schema.ts'
import { cn } from '#/lib/utils'

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

  if (!session)
    return {
      signedIn: false,
      microsoftConfigured: isMicrosoftConfigured(),
    } as const

  // Scoped to the signed-in user: every mailbox they own is read and merged into
  // one list, and no other account's mail is reachable from here.
  return loadInbox(session.userId)
})

/**
 * One thread's newest message, for the list's preview column.
 *
 * Deliberately a smaller payload than the conversation route's loader: the panel
 * only draws the last message and a few facts about the thread, and this is
 * fetched as the pointer moves, so it has to stay cheap to send.
 */
const fetchPreview = createServerFn({ method: 'GET' })
  .validator((data: { providerThreadId: string }) => data)
  .handler(
    async ({
      data,
    }): Promise<{ preview: MailPreview | null; error: string | null }> => {
      const session = await getSession()
      if (!session) return { preview: null, error: 'You are not signed in.' }

      try {
        const detail = await loadConversation(
          session.userId,
          data.providerThreadId,
        )
        if (!detail) return { preview: null, error: null }

        // The newest message is what a glance needs; the two before it give the
        // thread enough context to judge, without shipping the whole thing.
        const recent = detail.messages.slice(-3)
        const contact = detail.contactContext
        const files = detail.attachments.filter(
          (attachment) => !attachment.isInline,
        )

        return {
          preview: {
            providerThreadId: detail.providerThreadId,
            subject: detail.subject,
            topic: detail.topic,
            goal: detail.goal,
            state: detail.state,
            done: detail.done,
            accountEmail: detail.accountEmail,
            participants: detail.participants.map((participant) => ({
              name: participant.name,
              email: participant.email,
              initials: participant.initials,
              avatarUrl: participant.avatarUrl,
            })),
            messages: recent.map((message, index) => ({
              from: message.from.name ?? message.from.email,
              sentAt: message.sentAt,
              isFromOwner: message.isFromOwner,
              // The newest gets room to be read; the older ones only have to
              // remind. Both are capped so a pointer moving down the list does
              // not pull whole newsletters over the wire.
              body: message.body
                .replace(/\n{3,}/g, '\n\n')
                .trim()
                .slice(0, index === recent.length - 1 ? 1400 : 350),
            })),
            messageCount: detail.messages.length,
            attachmentCount: files.length,
            attachments: files.slice(0, 6).map((attachment) => ({
              filename: attachment.filename,
              sizeBytes: attachment.sizeBytes,
            })),
            replyable: detail.replyable,
            importance: detail.importance,
            senderImportance: detail.senderImportance,
            contact: contact
              ? {
                  roleCompany: contact.roleCompany || null,
                  relationship: contact.relationship || null,
                  topics: contact.topics || null,
                  currentWork: contact.currentWork || null,
                }
              : null,
          },
          error: null,
        }
      } catch (error) {
        console.error('[preview] failed:', error)
        return { preview: null, error: 'Could not load that preview.' }
      }
    },
  )

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
 * Mark a thread done, or take the mark back, from the inbox itself.
 *
 * The same call the conversation view makes, exposed here so a row's menu can
 * triage without opening the thread. No Gmail call and no AI call — the mark is
 * the user's own answer about whether they handled it.
 */
const setDoneAction = createServerFn({ method: 'POST' })
  .validator((data: { providerThreadId: string; done: boolean }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    if (typeof data.done !== 'boolean') {
      return { error: 'Done has to be true or false.' }
    }

    try {
      await setConversationDone(
        session.userId,
        data.providerThreadId,
        data.done,
      )
      return { error: null }
    } catch (error) {
      console.error('[done] marking the thread failed:', error)
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Could not update this conversation.',
      }
    }
  })

/**
 * Label a thread from the inbox, or hand it back to the app.
 *
 * `state: null` clears the stored label and lets the decision layer file the
 * thread again. Validated here rather than trusted: the value is written to the
 * column every section groups by.
 */
const setStateOverrideAction = createServerFn({ method: 'POST' })
  .validator(
    (data: { providerThreadId: string; state: ConversationState | null }) =>
      data,
  )
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    if (data.state !== null && !CONVERSATION_STATES.includes(data.state)) {
      return { error: 'That is not a state a conversation can be in.' }
    }

    try {
      await applyUserStateOverride(
        session.userId,
        data.providerThreadId,
        data.state,
      )
      return { error: null }
    } catch (error) {
      console.error('[state] override failed:', error)
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Could not update this conversation.',
      }
    }
  })

/**
 * A selection is chosen in the browser, so it arrives as untrusted input.
 *
 * Deduplicated and trimmed here rather than in the two actions below: both need
 * the same answer to "is this a selection at all", and a repeated id would
 * otherwise run the same write twice.
 */
const MAX_BATCH_THREADS = 200

function cleanThreadIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const ids = value
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .filter(Boolean)

  return [...new Set(ids)]
}

/**
 * Mark threads read or unread from the inbox's row menu.
 *
 * Unlike Done and the labels this is not local state: the read flag belongs to
 * the mailbox, so Gmail is written first and the row is only changed once it
 * agreed. A whole selection arrives as one request, with each thread counted
 * separately so one bad row does not abandon the rest.
 */
const setUnreadAction = createServerFn({ method: 'POST' })
  .validator((data: { providerThreadIds: string[]; unread: boolean }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    if (typeof data.unread !== 'boolean') {
      return { error: 'Unread has to be true or false.' }
    }

    const ids = cleanThreadIds(data.providerThreadIds)
    if (ids.length === 0) return { error: 'No conversations were selected.' }
    if (ids.length > MAX_BATCH_THREADS) {
      return {
        error: `Select up to ${MAX_BATCH_THREADS} conversations at once.`,
      }
    }

    let failed = 0
    let reason: string | null = null
    for (const providerThreadId of ids) {
      try {
        await setConversationUnread(
          session.userId,
          providerThreadId,
          data.unread,
        )
      } catch (error) {
        failed += 1
        reason = error instanceof Error ? error.message : null
        console.error('[unread] batch item failed:', error)
      }
    }

    if (failed === 0) return { error: null }
    return {
      error:
        failed === ids.length
          ? (reason ?? 'None of the selected conversations could be updated.')
          : `${failed} of ${ids.length} conversations could not be updated.`,
    }
  })

/**
 * Move threads into one of the user's custom labels, or hand them back to the
 * rules with `groupId: null`.
 *
 * Local only: a custom label is Nuntia's own filing and Gmail knows nothing
 * about it, so there is no provider to write to. The label id comes from the
 * browser and is checked against the user's own rules in the service.
 */
const setOrganizationGroupAction = createServerFn({ method: 'POST' })
  .validator(
    (data: { providerThreadIds: string[]; groupId: string | null }) => data,
  )
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    if (data.groupId !== null && typeof data.groupId !== 'string') {
      return { error: 'That is not a label.' }
    }

    const ids = cleanThreadIds(data.providerThreadIds)
    if (ids.length === 0) return { error: 'No conversations were selected.' }
    if (ids.length > MAX_BATCH_THREADS) {
      return {
        error: `Select up to ${MAX_BATCH_THREADS} conversations at once.`,
      }
    }

    let failed = 0
    let reason: string | null = null
    for (const providerThreadId of ids) {
      try {
        await setConversationOrganizationGroup(
          session.userId,
          providerThreadId,
          data.groupId,
        )
      } catch (error) {
        failed += 1
        reason = error instanceof Error ? error.message : null
        console.error('[label] move failed:', error)
      }
    }

    if (failed === 0) return { error: null }
    return {
      error:
        failed === ids.length
          ? (reason ?? 'None of the selected conversations could be moved.')
          : `${failed} of ${ids.length} conversations could not be moved.`,
    }
  })

/**
 * Save the user's inbox section order after a drag.
 *
 * The order arrives as tokens from the browser, so it is made valid here against
 * the labels the user has now — unknown tokens dropped, duplicates collapsed,
 * missing sections appended — before it is stored. That keeps a deleted label
 * from leaving a gap and a newly created one from being invisible.
 */
const saveInboxOrderAction = createServerFn({ method: 'POST' })
  .validator((data: { order: string[] }) => data)
  .handler(
    async ({ data }): Promise<{ error: string | null; order?: string[] }> => {
      const session = await getSession()
      if (!session) return { error: 'You are not signed in.' }

      if (!Array.isArray(data.order)) {
        return { error: 'That is not a section order.' }
      }

      try {
        const labels = await listOrganizationLabels(session.userId)
        const order = resolveInboxOrder(
          data.order,
          labels.filter((label) => label.enabled).map((label) => label.id),
        )
        await savePreferences(session.userId, { inboxOrder: order })
        return { error: null, order }
      } catch (error) {
        console.error('[inbox order] saving failed:', error)
        return {
          error:
            error instanceof Error
              ? error.message
              : 'Could not save the new order.',
        }
      }
    },
  )

/**
 * Mark many threads done, or take the mark back, in one request.
 *
 * One server call rather than a loop in the browser: each write is independent,
 * so a failure is counted instead of aborting the rest, and the list refreshes
 * once at the end. No provider call and no AI call — this is the user's own mark.
 */
const setDoneBatchAction = createServerFn({ method: 'POST' })
  .validator((data: { providerThreadIds: string[]; done: boolean }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    if (typeof data.done !== 'boolean') {
      return { error: 'Done has to be true or false.' }
    }

    const ids = cleanThreadIds(data.providerThreadIds)
    if (ids.length === 0) return { error: 'No conversations were selected.' }
    if (ids.length > MAX_BATCH_THREADS) {
      return {
        error: `Select up to ${MAX_BATCH_THREADS} conversations at once.`,
      }
    }

    let failed = 0
    for (const providerThreadId of ids) {
      try {
        await setConversationDone(session.userId, providerThreadId, data.done)
      } catch (error) {
        failed += 1
        console.error('[done] batch item failed:', error)
      }
    }

    if (failed === 0) return { error: null }
    return {
      error:
        failed === ids.length
          ? 'None of the selected conversations could be updated.'
          : `${failed} of ${ids.length} conversations could not be updated.`,
    }
  })

/** Relabel many threads, or hand them all back with `state: null`. */
const setStateBatchAction = createServerFn({ method: 'POST' })
  .validator(
    (data: { providerThreadIds: string[]; state: ConversationState | null }) =>
      data,
  )
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    if (data.state !== null && !CONVERSATION_STATES.includes(data.state)) {
      return { error: 'That is not a state a conversation can be in.' }
    }

    const ids = cleanThreadIds(data.providerThreadIds)
    if (ids.length === 0) return { error: 'No conversations were selected.' }
    if (ids.length > MAX_BATCH_THREADS) {
      return {
        error: `Select up to ${MAX_BATCH_THREADS} conversations at once.`,
      }
    }

    let failed = 0
    for (const providerThreadId of ids) {
      try {
        await applyUserStateOverride(
          session.userId,
          providerThreadId,
          data.state,
        )
      } catch (error) {
        failed += 1
        console.error('[state] batch item failed:', error)
      }
    }

    if (failed === 0) return { error: null }
    return {
      error:
        failed === ids.length
          ? 'None of the selected conversations could be updated.'
          : `${failed} of ${ids.length} conversations could not be updated.`,
    }
  })

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

export const Route = createFileRoute('/_mailbox')({
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
  // The thread route renders beside the list instead of replacing it, so the
  // layout has to know whether one is open — a mailbox URL means yes. Reading it
  // from the router rather than state keeps deep links and Back working.
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const threadOpen = pathname.startsWith('/conversations/')

  // A boolean rather than the list itself: the effect below should restart when
  // a sync starts or ends, not on every progress tick within one. Signed out is
  // not a case here — the loader redirects it to the sign-in page.
  const syncing = payload.syncing.length > 0

  const [section, setSection] = useState('all')
  const [composeOpen, setComposeOpen] = useState(false)
  // Questions open in the app rather than on `/ask`: the list they were
  // noticed in stays behind the window.
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [questionFormId, setQuestionFormId] = useState<string | null>(null)
  // The only part of compose the inbox payload does not already hold. Fetched
  // when the window opens, so the list does not pay for it on every load.
  const [composeSuggestions, setComposeSuggestions] = useState<
    Array<{ email: string; name: string | null }>
  >([])

  /**
   * The sidebar's sections, in the order the user arranged them.
   *
   * The design moved the section list out of the page and into the shell, so it
   * is built here from the same tokens and counts the list groups by — a custom
   * label can still sit above Needs action, because that is the order's point.
   */
  const sections = useMemo<ShellSection[]>(() => {
    const customLabels = payload.organizationLabels.filter(
      (label) => label.enabled,
    )
    const byToken = new Map<string, ShellSection>()

    for (const state of STATE_ORDER) {
      byToken.set(`state:${state}`, {
        key: `state:${state}`,
        title: payload.stateLabels[state].name,
        dotClass: STATE_META[state].dotClass,
        count: payload.counts[state],
      })
    }

    for (const label of customLabels) {
      byToken.set(`label:${label.id}`, {
        key: `label:${label.id}`,
        title: label.name,
        dotClass: 'bg-primary',
        // Counted from the open rows, like the list's own headings: a label's
        // done mail is filed under Done, not under the label.
        count: payload.conversations.filter(
          (conversation) =>
            !conversation.done &&
            conversation.organizationGroup?.id === label.id,
        ).length,
        custom: true,
      })
    }

    const ordered = resolveInboxOrder(
      payload.inboxOrder,
      customLabels.map((label) => label.id),
    ).flatMap((token) => {
      const entry = byToken.get(token)
      return entry ? [entry] : []
    })

    // Done is deliberately outside the arrangement — finished mail is always
    // last — so it is appended rather than resolved from a token.
    return payload.doneCount > 0
      ? [
          ...ordered,
          {
            key: 'done',
            title: DONE_GROUP.label,
            dotClass: 'bg-muted-foreground',
            count: payload.doneCount,
            muted: true,
          },
        ]
      : ordered
  }, [payload])

  useEffect(() => {
    if (!composeOpen) return

    let cancelled = false
    void loadComposeState()
      .then((state) => {
        if (cancelled || !state.signedIn) return
        setComposeSuggestions(state.suggestions)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [composeOpen])

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
    <AppShell
      sections={sections}
      activeSection={section}
      onSelectSection={setSection}
      accounts={payload.accounts}
      onCompose={() => setComposeOpen(true)}
    >
      <div className="flex min-h-screen w-full">
        <div
          className={cn(
            // The list owns its own scroll surface on a wide screen. The thread
            // opens beside it, not over it, and nothing the thread does — an
            // effect, a focus, a re-render — can move the list then, because the
            // list's position is the element's own `scrollTop` rather than the
            // window's.
            'min-w-0 flex-1 md:h-dvh md:overflow-y-auto md:overscroll-contain',
            threadOpen && 'hidden md:block md:w-[22rem] md:flex-none',
          )}
        >
          <Inbox
            payload={payload}
            embedded
            section={section}
            onSectionChange={setSection}
            onCompose={() => setComposeOpen(true)}
            hidePreview={threadOpen}
            formPrompt={formPrompt}
            openFormCount={openFormCount}
            onResync={async () => {
              const result = await resyncInbox()
              // The action has already written whatever it could, so a refresh is
              // what makes the list reflect it.
              if (!result.error) await router.invalidate()
              return result
            }}
            onOpenQuestions={(formId) => {
              setQuestionFormId(formId ?? null)
              setQuestionsOpen(true)
            }}
            onDismissForm={async (formId) => {
              const result = await dismissFormPrompt({ data: { formId } })
              if (!result.error) await router.invalidate()
              return result
            }}
            onSearch={(query) => searchInbox({ data: { query } })}
            onPreview={(providerThreadId) =>
              fetchPreview({ data: { providerThreadId } })
            }
            onSetDone={async (providerThreadId, done) => {
              const result = await setDoneAction({
                data: { providerThreadId, done },
              })
              if (!result.error) await router.invalidate()
              return result
            }}
            onSetState={async (providerThreadId, state) => {
              const result = await setStateOverrideAction({
                data: { providerThreadId, state },
              })
              if (!result.error) await router.invalidate()
              return result
            }}
            onSetDoneMany={async (providerThreadIds, done) => {
              const result = await setDoneBatchAction({
                data: { providerThreadIds, done },
              })
              if (!result.error) await router.invalidate()
              return result
            }}
            onSetStateMany={async (providerThreadIds, state) => {
              const result = await setStateBatchAction({
                data: { providerThreadIds, state },
              })
              if (!result.error) await router.invalidate()
              return result
            }}
            onSetUnread={async (providerThreadIds, unread) => {
              const result = await setUnreadAction({
                data: { providerThreadIds, unread },
              })
              if (!result.error) await router.invalidate()
              return result
            }}
            onSetOrganizationGroup={async (providerThreadIds, groupId) => {
              const result = await setOrganizationGroupAction({
                data: { providerThreadIds, groupId },
              })
              if (!result.error) await router.invalidate()
              return result
            }}
            onReorderSections={async (order) => {
              const result = await saveInboxOrderAction({ data: { order } })
              if (!result.error) await router.invalidate()
              return result
            }}
          />
        </div>

        {threadOpen ? (
          <div className="sticky top-0 flex h-dvh min-w-0 flex-1 flex-col border-l border-border bg-background max-md:fixed max-md:inset-0 max-md:z-40">
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
              <span className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                Thread
              </span>
              <Link
                to="/"
                // The list kept its place while the thread was open; closing it
                // is returning to that list, not leaving it.
                resetScroll={false}
                aria-label="Close thread"
                className="flex size-7 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X aria-hidden="true" className="size-4" />
              </Link>
            </div>
            <div className="min-h-0 flex-1">
              <Outlet />
            </div>
          </div>
        ) : null}
      </div>

      <QuestionsOverlay
        open={questionsOpen}
        initialFormId={questionFormId}
        onClose={() => setQuestionsOpen(false)}
        onAnswered={() => void router.invalidate()}
      />

      <ComposeOverlay
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        accounts={payload.accounts}
        suggestions={composeSuggestions}
        loadStyle={(input) => loadStylePreview({ data: input })}
        submit={async (input) => {
          const result = await sendMessageAction({ data: input })

          if (!result.error) {
            setComposeOpen(false)
            await router.invalidate()

            if (result.threadId) {
              await router.navigate({
                to: '/conversations/$providerThreadId',
                params: { providerThreadId: result.threadId },
              })
            }
            // Graph reports no thread id: the message lands on the next sync,
            // and the list the user is already looking at is the destination.
          }

          return result
        }}
      />
    </AppShell>
  )
}
