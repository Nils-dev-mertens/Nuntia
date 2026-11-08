/**
 * Compose's server side, shared by the full page and the inbox overlay.
 *
 * These lived in `routes/compose.tsx` until the design made composing a window
 * over the inbox. Two routes now need the same three calls, and a route module
 * importing another route module would drag the one route's component tree (and
 * its router registration) along with it.
 */

import { createServerFn } from '@tanstack/react-start'

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
export const loadComposeState = createServerFn({ method: 'GET' }).handler(
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
export const loadStylePreview = createServerFn({ method: 'GET' })
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

export const sendMessageAction = createServerFn({ method: 'POST' })
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
