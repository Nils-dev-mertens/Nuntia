/**
 * Free-text matching for the inbox search.
 *
 * Search runs over the conversations already stored, not over the provider: the
 * inbox sync is what brings mail in, and a search box that waited on Gmail (or
 * on a decision per result) would be the slowest thing on the page. It therefore
 * covers what the sync has read — the synced window, including threads outside
 * the section ten-item view.
 *
 * Every word has to appear somewhere, in any order, which is what people mean
 * by a search rather than a phrase match. Matching is case-insensitive and
 * covers the fields a reader would recognise a thread by: subject, the user's
 * topic, both sides of the correspondence, and the message text itself.
 */

import type { ConversationMessage } from '#/lib/conversation/index.ts'

/**
 * Only the fields a search reads, so a caller holding a whole conversation and
 * a test holding two messages can both use the same rule.
 */
export type SearchableConversation = {
  subject: string
  topic: string | null
  participants: ReadonlyArray<{ name?: string | null; email: string }>
  messages: ReadonlyArray<
    Pick<ConversationMessage, 'subject' | 'snippet' | 'body'>
  >
}

export function conversationMatchesQuery(
  conversation: SearchableConversation,
  query: string,
): boolean {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true

  const haystack = [
    conversation.subject,
    conversation.topic ?? '',
    ...conversation.participants.flatMap((participant) => [
      participant.name ?? '',
      participant.email,
    ]),
    ...conversation.messages.flatMap((message) => [
      message.subject,
      message.snippet ?? '',
      message.body,
    ]),
  ]
    .join('\n')
    .toLocaleLowerCase()

  return terms.every((term) => haystack.includes(term))
}
