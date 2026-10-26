import { describe, expect, test } from 'bun:test'

import { conversationMatchesQuery } from './search.ts'
import type { SearchableConversation } from './search.ts'

function conversation(overrides: {
  subject?: string
  topic?: string | null
  participants?: SearchableConversation['participants']
  messages?: Array<{ subject?: string; snippet?: string | null; body?: string }>
}): SearchableConversation {
  return {
    subject: overrides.subject ?? 'Invoice for April',
    topic: overrides.topic ?? null,
    participants: overrides.participants ?? [
      { name: 'Ada Lovelace', email: 'ada@acme.example' },
    ],
    messages: (overrides.messages ?? [{ body: 'The invoice is attached.' }]).map(
      (message) => ({
        subject: message.subject ?? 'Invoice for April',
        snippet: message.snippet ?? null,
        body: message.body ?? '',
      }),
    ),
  }
}

describe('conversationMatchesQuery', () => {
  test('matches subject, topic, sender, recipient and message text', () => {
    const row = conversation({
      topic: 'Quarterly budget',
      participants: [
        { name: 'Ada Lovelace', email: 'ada@acme.example' },
        { name: null, email: 'finance@acme.example' },
      ],
      messages: [{ body: 'Please approve the revised numbers.' }],
    })

    for (const query of [
      'invoice',
      'quarterly',
      'lovelace',
      'finance@acme',
      'approve',
    ]) {
      expect(conversationMatchesQuery(row, query)).toBe(true)
    }
  })

  test('every word must appear, in any order', () => {
    const row = conversation({})

    expect(conversationMatchesQuery(row, 'april  invoice')).toBe(true)
    expect(conversationMatchesQuery(row, 'invoice february')).toBe(false)
  })

  test('is case-insensitive and treats blank input as everything', () => {
    const row = conversation({})

    expect(conversationMatchesQuery(row, 'APRIL')).toBe(true)
    expect(conversationMatchesQuery(row, '   ')).toBe(true)
    expect(conversationMatchesQuery(row, 'tax')).toBe(false)
  })
})
