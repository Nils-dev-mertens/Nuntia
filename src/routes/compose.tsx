/**
 * Write a new message.
 *
 * A page rather than a modal: composing is the whole task, and a full-width page
 * is the only layout where a long body and a recipient list fit without fighting
 * a dialog. Everything server-side sits behind server functions, so the session,
 * the mailbox client and the provider stay out of the browser bundle.
 */

import { createServerFn } from '@tanstack/react-start'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'

import { Compose } from '#/components/compose.tsx'
import type { ComposeInput } from '#/components/compose.tsx'
import type { RecipientSuggestion } from '#/components/recipient-field.tsx'
import { getSession, listAccounts, ownsAccount } from '#/lib/auth/index.ts'
import { listContactSuggestions } from '#/lib/contacts/index.ts'
import {
  sendNewMessage,
  resolveNewMessageStyle,
} from '#/lib/mailbox/send-new.ts'

/**
 * Which mailboxes the message may leave from, and who the user has written to
 * before. Both are per-person: the suggestions are the addresses from *their*
 * mailboxes, and their own addresses are left out of the list.
 */
const loadComposeState = createServerFn({ method: 'GET' }).handler(
  async (): Promise<
    | { signedIn: false }
    | {
        signedIn: true
        accounts: Array<{ id: string; email: string }>
        suggestions: RecipientSuggestion[]
      }
  > => {
    const session = await getSession()
    if (!session) return { signedIn: false }

    const accounts = await listAccounts(session.userId)
    const suggestions = await listContactSuggestions(
      accounts.map((account) => account.id),
      accounts.flatMap((account) => [account.id, account.email]),
    )

    return {
      signedIn: true,
      accounts: accounts.map((account) => ({
        id: account.id,
        email: account.email,
      })),
      suggestions: suggestions.map((suggestion) => ({
        email: suggestion.email,
        name: suggestion.name,
      })),
    }
  },
)

/**
 * The greeting and signature this recipient would get.
 *
 * The same function the send uses, called from the same inputs, so the panel the
 * composer shows cannot disagree with the message that goes out. Scoped to the
 * user's own mailboxes: the account id arrives from the browser.
 */
const loadStylePreview = createServerFn({ method: 'GET' })
  .validator((data: { accountId: string; recipient: string | null }) => data)
  .handler(
    async ({
      data,
    }): Promise<{ greeting: string | null; signature: string | null }> => {
      const session = await getSession()
      if (!session) return { greeting: null, signature: null }

      try {
        const accountId = data.accountId.trim().toLowerCase()
        if (!(await ownsAccount(session.userId, accountId))) {
          return { greeting: null, signature: null }
        }

        return await resolveNewMessageStyle(
          accountId,
          typeof data.recipient === 'string' && data.recipient.trim()
            ? data.recipient.trim()
            : null,
        )
      } catch (error) {
        // A preview is a nicety; failing to build one must not break the page.
        console.warn('[compose] could not resolve the message style:', error)
        return { greeting: null, signature: null }
      }
    },
  )

const sendMessageAction = createServerFn({ method: 'POST' })
  .validator((data: ComposeInput) => data)
  .handler(
    async ({
      data,
    }): Promise<{ error: string | null; threadId: string | null }> => {
      const session = await getSession()
      if (!session) {
        return { error: 'You are not signed in.', threadId: null }
      }

      try {
        const result = await sendNewMessage({
          userId: session.userId,
          accountId: data.accountId,
          to: data.to,
          cc: data.cc,
          bcc: data.bcc,
          subject: data.subject,
          body: data.body,
          attachments: data.attachments,
        })

        return { error: null, threadId: result.threadId }
      } catch (error) {
        console.error('[compose] send failed:', error)
        return {
          error:
            error instanceof Error
              ? error.message
              : 'Could not send the message.',
          threadId: null,
        }
      }
    },
  )

export const Route = createFileRoute('/compose')({
  loader: async () => {
    const state = await loadComposeState()
    if (!state.signedIn) throw redirect({ to: '/sign-in' })
    return state
  },
  component: ComposePage,
})

function ComposePage() {
  const { accounts, suggestions } = Route.useLoaderData()
  const router = useRouter()

  return (
    <Compose
      accounts={accounts}
      suggestions={suggestions}
      loadStyle={(input) => loadStylePreview({ data: input })}
      submit={async (input) => {
        const result = await sendMessageAction({ data: input })

        if (!result.error) {
          // The inbox and the thread both come from loader data: invalidate
          // before moving on, or the new conversation is not in the router's
          // cache yet and the detail page renders not-found.
          await router.invalidate()

          if (result.threadId) {
            await router.navigate({
              to: '/conversations/$providerThreadId',
              params: { providerThreadId: result.threadId },
            })
          } else {
            // Graph's send reports no thread id; the message appears on the
            // next sync, so the list is the honest destination.
            await router.navigate({ to: '/' })
          }
        }

        return result
      }}
    />
  )
}
