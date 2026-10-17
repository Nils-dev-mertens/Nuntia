/**
 * One conversation, rendered as chat.
 *
 * The loader is a server function so the conversation never has to round-trip
 * through a public API. The reply is a mutation that lives here too, rather than
 * in a REST route, so the same auth and error handling covers both.
 */

import { useEffect } from 'react'
import { createServerFn } from '@tanstack/react-start'
import { createFileRoute, useRouter } from '@tanstack/react-router'

import { ConversationView } from '#/components/conversation'
import { getSession } from '#/lib/auth/index.ts'
import {
  applyUserStateOverride,
  describeActionFailure,
  draftReply,
  loadConversation,
  markConversationSeen,
  markThreadSenderUnreplyable,
  reanalyseConversation,
  setConversationDone,
} from '#/lib/gmail/service.ts'
import { CONVERSATION_STATES } from '#/db/schema.ts'
import type { ConversationState } from '#/db/schema.ts'
import type { ActionFailure, ReplyDraftOutcome } from '#/lib/gmail/service.ts'
import {
  refreshThread,
  requireConversationByThreadId,
  sendReply,
} from '#/lib/gmail/send.ts'
import type { ReplyAttachmentUpload } from '#/lib/gmail/send.ts'
import {
  getParsingProfileContext,
  replyAccountsFor,
  resolveReplyStyle,
  saveParsingProfile,
  setConversationDetails,
} from '#/lib/conversation/index.ts'
import type { SenderProfileSettings } from '#/lib/conversation/index.ts'
import { syncThread } from '#/lib/gmail/sync.ts'
import { createGmailClient } from '#/lib/auth/google.ts'
import { getAccountEnvelope, listAccounts } from '#/lib/auth/accounts.ts'
import { createGmailApiClient } from '#/lib/gmail/client.ts'

/**
 * How long a draft instruction may be.
 *
 * The prompt carries it as one line, and a cap here means the length is refused
 * with a sentence rather than silently truncated inside `buildReplyDraftPrompt`.
 */
const MAX_DRAFT_INSTRUCTION_CHARS = 500

const saveParsingProfileAction = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: {
      gmailThreadId: string
      profile: SenderProfileSettings
      defaultReplyGreeting: string
      defaultReplySignature: string
      defaultStripQuotedHistory: boolean
      defaultStripGreeting: boolean
      defaultStripSignature: boolean
    }) => data,
  )
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }
    // The thread's own mailbox, not the session's: accounts are global and the
    // row came from whichever account owns it.
    const { accountId, conversation } = await requireConversationByThreadId(
      data.gmailThreadId,
    )
    const sender = [...conversation.messages]
      .reverse()
      .find((message) => !message.isFromOwner)
    const senderEmail = sender?.from.email
    if (!senderEmail)
      return { error: 'This conversation has no sender profile.' }
    if (
      typeof data.profile.stripQuotedHistory !== 'boolean' ||
      typeof data.profile.stripGreeting !== 'boolean' ||
      typeof data.profile.stripSignature !== 'boolean' ||
      typeof data.profile.useAccountParsingDefaults !== 'boolean' ||
      typeof data.profile.replyStyleEnabled !== 'boolean' ||
      typeof data.defaultStripQuotedHistory !== 'boolean' ||
      typeof data.defaultStripGreeting !== 'boolean' ||
      typeof data.defaultStripSignature !== 'boolean' ||
      (data.profile.replyGreeting !== null &&
        typeof data.profile.replyGreeting !== 'string') ||
      (data.profile.replySignature !== null &&
        typeof data.profile.replySignature !== 'string')
    ) {
      return { error: 'Parsing preferences are invalid.' }
    }
    const limits: Array<[string, unknown, number]> = [
      ['default reply greeting', data.defaultReplyGreeting, 200],
      ['default reply signature', data.defaultReplySignature, 1000],
      ['reply greeting', data.profile.replyGreeting ?? '', 200],
      ['reply signature', data.profile.replySignature ?? '', 1000],
    ]
    for (const [label, value, limit] of limits) {
      if (typeof value !== 'string' || value.length > limit) {
        return { error: `${label} must be ${limit} characters or fewer.` }
      }
    }
    await saveParsingProfile(
      accountId,
      senderEmail,
      {
        greeting: data.defaultReplyGreeting.trim() || null,
        signature: data.defaultReplySignature.trim() || null,
        parsing: {
          stripQuotedHistory: data.defaultStripQuotedHistory,
          stripGreeting: data.defaultStripGreeting,
          stripSignature: data.defaultStripSignature,
        },
      },
      {
        ...data.profile,
        replyGreeting: data.profile.replyGreeting?.trim() || null,
        replySignature: data.profile.replySignature?.trim() || null,
      },
    )

    try {
      const envelope = await getAccountEnvelope(accountId)
      if (!envelope)
        return {
          error: 'Preferences saved, but no Google account is connected.',
        }
      const client = createGmailApiClient(
        await createGmailClient(envelope),
        accountId,
      )
      const thread = await client.getThread(conversation.gmailThreadId)
      const profileContext = await getParsingProfileContext(accountId)
      const synced = await syncThread(
        accountId,
        thread,
        undefined,
        profileContext,
      )
      if (synced !== 'synced') {
        return {
          error:
            'Preferences saved, but the conversation could not be re-parsed.',
        }
      }
      return { error: null }
    } catch (error) {
      const reason = error instanceof Error ? ` ${error.message}` : ''
      return {
        error: `Preferences saved, but the conversation could not be re-parsed.${reason}`,
      }
    }
  })

const fetchConversation = createServerFn({ method: 'GET' })
  .inputValidator((data: { gmailThreadId: string }) => data)
  .handler(
    async ({
      data,
    }): Promise<
      | { found: false }
      | {
          found: true
          detail: NonNullable<Awaited<ReturnType<typeof loadConversation>>>
        }
    > => {
      const session = await getSession()
      if (!session) return { found: false }

      const detail = await loadConversation(data.gmailThreadId)
      if (!detail) return { found: false }

      return { found: true, detail }
    },
  )

/** Save the user-owned topic and goal for this account's conversation. */
const saveConversationDetailsAction = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: {
      gmailThreadId: string
      topic: string | null
      goal: string | null
    }) => data,
  )
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    const topic = normaliseEditableField(data.topic, 'Topic', 120)
    if (topic.error) return { error: topic.error }

    const goal = normaliseEditableField(data.goal, 'Goal', 500)
    if (goal.error) return { error: goal.error }

    try {
      const { accountId, conversation } = await requireConversationByThreadId(
        data.gmailThreadId,
      )
      await setConversationDetails(accountId, conversation.gmailThreadId, {
        topic: topic.value,
        goal: goal.value,
      })
      return { error: null }
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Could not save conversation details.',
      }
    }
  })

function normaliseEditableField(
  value: string | null,
  label: string,
  maxLength: number,
): { value: string | null; error: null } | { value: null; error: string } {
  if (value !== null && typeof value !== 'string') {
    return { value: null, error: `${label} must be text.` }
  }
  const trimmed = value?.trim() ?? ''
  if (trimmed.length > maxLength) {
    return {
      value: null,
      error: `${label} must be ${maxLength} characters or fewer.`,
    }
  }
  return { value: trimmed || null, error: null }
}

/**
 * Send a reply.
 *
 * Errors are returned rather than thrown so the composer can show them without
 * losing what the user typed — a failed send that clears the box is worse than
 * no send at all.
 */
const sendReplyAction = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: {
      gmailThreadId: string
      body: string
      attachments: ReplyAttachmentUpload[]
      /** Which of the user's addresses to send from; validated below. */
      fromAccountId: string | null
    }) => data,
  )
  .handler(async ({ data }): Promise<ActionFailure> => {
    const session = await getSession()
    if (!session)
      return { error: 'You are not signed in.', authRequired: false }

    try {
      const { accountId: ownerAccountId, conversation } =
        await requireConversationByThreadId(data.gmailThreadId)

      // Never trust the client's choice of sender: recompute the addresses that
      // are actually on this thread and fall back to the owning mailbox.
      const accounts = (await listAccounts()).map((account) => ({
        id: account.id,
        email: account.email,
      }))
      const allowed = new Set(
        replyAccountsFor(conversation.messages, accounts, ownerAccountId),
      )
      const accountId =
        data.fromAccountId && allowed.has(data.fromAccountId)
          ? data.fromAccountId
          : ownerAccountId

      const envelope = await getAccountEnvelope(accountId)
      if (!envelope) {
        return {
          error: 'No Google account is connected.',
          authRequired: true,
        }
      }

      const client = createGmailApiClient(
        await createGmailClient(envelope),
        accountId,
      )

      const profileContext = await getParsingProfileContext(accountId)
      const incoming = [...conversation.messages]
        .reverse()
        .find((message) => !message.isFromOwner)
      const lastOwnerMessage = [...conversation.messages]
        .reverse()
        .find((message) => message.isFromOwner)
      // Shared with the draft path (`service.ts`), which has to reach the same
      // answer to know whether to tell the model a greeting is arriving anyway.
      const replyStyle = resolveReplyStyle({
        account: {
          greeting: profileContext.replyStyles.account.greeting ?? null,
          signature: profileContext.replyStyles.account.signature ?? null,
        },
        sender: incoming
          ? (profileContext.replyStyles.senders[
              incoming.from.email.trim().toLowerCase()
            ] ?? null)
          : null,
        lastOwnerMessage,
      })

      await sendReply(client, accountId, conversation, data.body, {
        attachments: data.attachments,
        replyStyle,
      })

      // Sending does not touch our database, and the sync cursor has already
      // moved past this thread. Re-fetching is what makes the sent reply appear
      // immediately instead of whenever the next sync happens to run.
      await refreshThread(client, accountId, data.gmailThreadId)

      return { error: null, authRequired: false }
    } catch (error) {
      console.error('[send] reply failed:', error)
      return describeActionFailure(error, 'Could not send the reply.')
    }
  })

/**
 * Re-run the classification for one thread on demand.
 *
 * Sync only revisits threads Gmail reports as changed, so a thread classified
 * before Jev or the topic LLM was configured would keep its old answer. This
 * runs the same pipeline over the stored conversation — no Gmail call, so there
 * is no auth failure to report.
 */
const reanalyseAction = createServerFn({ method: 'POST' })
  .inputValidator((data: { gmailThreadId: string }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    try {
      await reanalyseConversation(data.gmailThreadId)
      return { error: null }
    } catch (error) {
      console.error('[reanalyse] failed:', error)
      return {
        error: describeActionFailure(error, 'Could not re-analyse this conversation.')
          .error,
      }
    }
  })

/**
 * Store the user's own call on where this thread belongs, or take one back.
 *
 * The state is validated here rather than trusted: it is written straight to the
 * column the whole inbox groups by, so anything that is not one of the states
 * the app knows would put a thread in a group that does not exist.
 */
const setStateOverrideAction = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: { gmailThreadId: string; state: ConversationState | null }) => data,
  )
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    if (data.state !== null && !CONVERSATION_STATES.includes(data.state)) {
      return { error: 'That is not a state a conversation can be in.' }
    }

    try {
      await applyUserStateOverride(data.gmailThreadId, data.state)
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
 * Mark a thread done, or take the mark back.
 *
 * The user's own call, and the only thing that sets it — not a sync, not the
 * decision layer, and deliberately not opening the thread, which is what
 * `markSeenAction` below records separately. No Gmail call and no AI call, so
 * there is no auth failure to report.
 */
const setDoneAction = createServerFn({ method: 'POST' })
  .validator((data: { gmailThreadId: string; done: boolean }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    if (typeof data.done !== 'boolean') {
      return { error: 'Done has to be true or false.' }
    }

    try {
      await setConversationDone(data.gmailThreadId, data.done)
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
 * Mark this thread's sender as one a reply cannot reach.
 *
 * The quick-add half of the can't-reply list. It names a *thread* rather than an
 * address, which is the whole point: the mailbox and the sender are both already
 * known here, so nothing is picked and nothing is typed. The mark is taken back
 * from Settings, where the list lives — this is a second way to *add* an entry,
 * not a second place it is managed.
 */
const markSenderUnreplyableAction = createServerFn({ method: 'POST' })
  .validator((data: { gmailThreadId: string }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    try {
      return await markThreadSenderUnreplyable(data.gmailThreadId)
    } catch (error) {
      console.error('[replyability] marking the sender failed:', error)
      return {
        error:
          error instanceof Error ? error.message : 'Could not mark this sender.',
      }
    }
  })

/**
 * Generate a draft reply for this thread, on demand.
 *
 * No `router.invalidate()` on success: nothing was stored. The draft lives in
 * the composer, where the user can edit it, and only Send writes anything — the
 * server re-applies the same conditions the view used, so a button left from an
 * older render cannot spend a call on a thread that no longer qualifies.
 */
const draftReplyAction = createServerFn({ method: 'POST' })
  .validator(
    (data: { gmailThreadId: string; instructions: string | null }) => data,
  )
  .handler(async ({ data }): Promise<ReplyDraftOutcome> => {
    const session = await getSession()
    if (!session) return { draft: null, error: 'You are not signed in.' }

    if (data.instructions !== null && typeof data.instructions !== 'string') {
      return { draft: null, error: 'That instruction is not text.' }
    }
    if (
      typeof data.instructions === 'string' &&
      data.instructions.length > MAX_DRAFT_INSTRUCTION_CHARS
    ) {
      return {
        draft: null,
        error: `Keep the instruction under ${MAX_DRAFT_INSTRUCTION_CHARS} characters.`,
      }
    }

    return await draftReply(data.gmailThreadId, data.instructions)
  })

/**
 * Record that the user has opened this thread, so it stops reading as new mail.
 *
 * Fired by the view, with the timestamp of the newest message it actually had on
 * screen — the row's own newest message may include mail that synced in after the
 * page was rendered, and marking that seen would lose it. Best-effort: a failure
 * costs the unread dot and nothing else, so it is not surfaced to the user.
 */
const markSeenAction = createServerFn({ method: 'POST' })
  .validator((data: { gmailThreadId: string; seenThrough: string }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    try {
      await markConversationSeen(data.gmailThreadId, data.seenThrough)
      return { error: null }
    } catch (error) {
      console.error('[seen] marking the thread read failed:', error)
      return { error: 'Could not record that this thread was opened.' }
    }
  })

export const Route = createFileRoute('/conversations/$gmailThreadId')({
  loader: ({ params }) =>
    fetchConversation({ data: { gmailThreadId: params.gmailThreadId } }),
  notFoundComponent: ConversationMissing,
  component: ConversationRoute,
})

function ConversationMissing() {
  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold">Conversation not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        It may not have synced yet, or the link is out of date.
      </p>
    </div>
  )
}

function ConversationRoute() {
  // Not destructured: the discriminated union narrows on the object, and
  // narrowing a destructured binding is what loses the `detail` here.
  const result = Route.useLoaderData()
  const router = useRouter()

  // Opening the thread *is* "viewed", and this is the only place that knows it
  // happened. Declared before the `found` branch so the hook is unconditional.
  //
  // Deliberately not followed by `router.invalidate()`: the "New messages"
  // divider the view is drawing comes from the loader's `seenAt`, and re-running
  // the loader the instant the mark lands would erase it as it appeared. The next
  // load of this thread is the one that shows it as read.
  const openedThreadId = result.found ? result.detail.gmailThreadId : null
  const seenThrough = result.found
    ? (result.detail.messages.at(-1)?.sentAt ?? null)
    : null

  useEffect(() => {
    if (!openedThreadId || !seenThrough) return
    void markSeenAction({
      data: { gmailThreadId: openedThreadId, seenThrough },
    })
  }, [openedThreadId, seenThrough])

  if (!result.found) {
    return <ConversationMissing />
  }

  const { detail } = result

  return (
    <ConversationView
      detail={detail}
      onSaveParsingProfile={async (profile, defaults) => {
        const saved = await saveParsingProfileAction({
          data: {
            gmailThreadId: detail.gmailThreadId,
            profile,
            defaultReplyGreeting: defaults.greeting,
            defaultReplySignature: defaults.signature,
            defaultStripQuotedHistory: defaults.stripQuotedHistory,
            defaultStripGreeting: defaults.stripGreeting,
            defaultStripSignature: defaults.stripSignature,
          },
        })
        if (!saved.error) await router.invalidate()
        return saved
      }}
      onSaveDetails={async (topic: string | null, goal: string | null) => {
        const saved = await saveConversationDetailsAction({
          data: {
            gmailThreadId: detail.gmailThreadId,
            topic,
            goal,
          },
        })
        if (!saved.error) await router.invalidate()
        return saved
      }}
      onReanalyse={async () => {
        const result = await reanalyseAction({
          data: { gmailThreadId: detail.gmailThreadId },
        })
        if (!result.error) await router.invalidate()
        return result
      }}
      onSetStateOverride={async (state) => {
        const saved = await setStateOverrideAction({
          data: { gmailThreadId: detail.gmailThreadId, state },
        })
        if (!saved.error) await router.invalidate()
        return saved
      }}
      onDraft={async (instructions: string | null) =>
        draftReplyAction({
          data: { gmailThreadId: detail.gmailThreadId, instructions },
        })
      }
      onMarkSenderUnreplyable={async () => {
        const marked = await markSenderUnreplyableAction({
          data: { gmailThreadId: detail.gmailThreadId },
        })
        if (!marked.error) await router.invalidate()
        return marked
      }}
      onSetDone={async (done) => {
        const saved = await setDoneAction({
          data: { gmailThreadId: detail.gmailThreadId, done },
        })
        if (!saved.error) await router.invalidate()
        return saved
      }}
      onSend={async (
        body: string,
        attachments: ReplyAttachmentUpload[],
        fromAccountId: string,
      ) => {
        const sent = await sendReplyAction({
          data: {
            gmailThreadId: detail.gmailThreadId,
            body,
            attachments,
            fromAccountId,
          },
        })

        if (!sent.error) {
          // Re-run the loader so the sent message shows up.
          await router.invalidate()
        }

        return sent
      }}
    />
  )
}
