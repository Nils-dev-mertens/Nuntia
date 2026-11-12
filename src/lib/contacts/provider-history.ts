/**
 * Earlier mail from one correspondent, asked for at the mailbox itself.
 *
 * `loadContactHistory` reads what the sync stored, which only reaches as far back
 * as the sync has walked — thirty days on a freshly connected mailbox. A
 * relationship that started last spring is therefore invisible to the profile
 * updater, and the note it writes describes a stranger. This searches the
 * mailbox directly for the newest threads from the address and returns them in
 * the same bounded shape, so the prompt does not learn a second format.
 *
 * Server only, and deliberately not on the sync path: one search plus one fetch
 * per thread is a cost paid when a person asks for a profile to be drafted, not
 * once per correspondent in every backfill. A provider that cannot search has no
 * `searchThreads`, and contributes nothing rather than failing the profile.
 */

import { listAccounts } from '#/lib/auth/accounts.ts'
import { toParsedMessage } from '#/lib/mailbox/message.ts'
import { createMailboxClientFor } from '#/lib/mailbox/provider.ts'
import type { ProviderThread } from '#/lib/mailbox/types.ts'

import { normaliseContactEmail } from './matching.ts'
import type { ContactHistoryThread } from './history.ts'

/** Threads one call may add. The profile prompt reads four, so this is plenty. */
const MAX_THREADS = 3

/** Newest messages per thread, matching what the stored history offers. */
const MAX_MESSAGES_PER_THREAD = 4

const MAX_BODY_CHARS = 1_200

/**
 * Turn one provider thread into the history shape.
 *
 * Exported so it can be tested without a database or a network: this is the part
 * that can be wrong about a MIME tree, and it is also the part that decides what
 * counts as a message worth showing a model.
 */
export function toContactHistoryThread(
  thread: ProviderThread,
): ContactHistoryThread | null {
  const messages = thread.messages
    .map((message) => {
      const parsed = toParsedMessage(message)
      // Plain text first, for the same reason the conversation model prefers it:
      // its quoting is normalised. HTML is the fallback, not a second body.
      const body = (
        parsed.parts.find((part) => part.contentType === 'text/plain')?.text ??
        parsed.parts.find((part) => part.contentType === 'text/html')?.text ??
        ''
      ).trim()

      return {
        sender: parsed.fromName?.trim() || parsed.from,
        sentAt: (parsed.date ?? new Date(0)).toISOString(),
        body,
        subject: parsed.subject,
      }
    })
    .filter((message) => message.body.length > 0)
    // The newest messages, not the oldest: a long thread's opening message is
    // usually the one fact the stored history already knows.
    .slice(-MAX_MESSAGES_PER_THREAD)

  if (messages.length === 0) return null

  return {
    providerThreadId: thread.id,
    subject: messages[0]?.subject.trim() || '(no subject)',
    messages: messages.map(({ sender, sentAt, body }) => ({
      sender,
      sentAt,
      body: body.slice(0, MAX_BODY_CHARS),
    })),
  }
}

export type ProviderHistoryOptions = {
  /** Thread ids already known — stored, or already offered — so none repeat. */
  excludeProviderThreadIds?: Iterable<string>
  limit?: number
}

/**
 * Search this user's mailboxes for threads from `email`.
 *
 * Every mailbox is asked, because the same person writes to more than one of the
 * user's addresses and a profile is about the person rather than a mailbox. A
 * mailbox that fails contributes nothing: the caller still has the stored
 * history, and a search that could not run is a log line rather than an error
 * the person waiting for a draft has to act on.
 */
export async function searchMailboxContactHistory(
  userId: string,
  email: string,
  options: ProviderHistoryOptions = {},
): Promise<ContactHistoryThread[]> {
  const address = normaliseContactEmail(email)
  if (!address) return []

  const limit = Math.max(1, options.limit ?? MAX_THREADS)
  const exclude = new Set(options.excludeProviderThreadIds ?? [])
  const accounts = await listAccounts(userId)

  const found: ContactHistoryThread[] = []
  for (const account of accounts) {
    if (found.length >= limit) break

    try {
      const client = await createMailboxClientFor(account.id)
      // No method means the provider cannot search; that is a normal answer.
      if (!client?.searchThreads) continue

      const threads = await client.searchThreads({
        from: address,
        // Ask for the ones already excluded too, or a search that returns only
        // stored threads would come back empty and look like an empty mailbox.
        maxResults: limit + exclude.size,
      })

      for (const thread of threads) {
        if (found.length >= limit) break
        if (exclude.has(thread.id)) continue
        exclude.add(thread.id)

        const history = toContactHistoryThread(thread)
        if (history) found.push(history)
      }
    } catch (error) {
      console.error(
        `[contacts] searching ${account.id} for earlier mail failed:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  return found
}
