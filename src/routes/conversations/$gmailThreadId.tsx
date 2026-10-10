/**
 * One conversation, rendered as chat.
 *
 * The loader is a server function so the conversation never has to round-trip
 * through a public API. The reply is a mutation that lives here too, rather than
 * in a REST route, so the same auth and error handling covers both.
 */

import { createServerFn } from '@tanstack/react-start'
import { createFileRoute, useRouter } from '@tanstack/react-router'

import { ConversationView } from '#/components/conversation'
import { getSession } from '#/lib/auth/index.ts'
import {
  describeActionFailure,
  loadConversation,
  reanalyseConversation,
} from '#/lib/gmail/service.ts'
import type { ActionFailure } from '#/lib/gmail/service.ts'
import {
  refreshThread,
  requireConversationByThreadId,
  sendReply,
} from '#/lib/gmail/send.ts'
import type { ReplyAttachmentUpload } from '#/lib/gmail/send.ts'
import {
  getParsingProfileContext,
  replyAccountsFor,
  saveParsingProfile,
  setConversationDetails,
} from '#/lib/conversation/index.ts'
import type { SenderProfileSettings } from '#/lib/conversation/index.ts'
import { syncThread } from '#/lib/gmail/sync.ts'
import { createGmailClient } from '#/lib/auth/google.ts'
import { getAccountEnvelope, listAccounts } from '#/lib/auth/accounts.ts'
import { createGmailApiClient } from '#/lib/gmail/client.ts'

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
      const senderProfile = incoming
        ? profileContext.replyStyles.senders[
            incoming.from.email.trim().toLowerCase()
          ]
        : undefined
      const lastOwnerMessage = [...conversation.messages]
        .reverse()
        .find((message) => message.isFromOwner)
      const replyStyle = senderProfile?.enabled
        ? {
            greeting: senderProfile.greeting,
            signature: senderProfile.signature,
          }
        : {
            greeting:
              profileContext.replyStyles.account.greeting ??
              lastOwnerMessage?.detectedGreeting ??
              lastOwnerMessage?.greeting ??
              null,
            signature:
              profileContext.replyStyles.account.signature ??
              lastOwnerMessage?.detectedSignature ??
              lastOwnerMessage?.signature ??
              null,
          }

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
