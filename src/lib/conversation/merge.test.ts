import { describe, expect, test } from 'bun:test'

import type { Participant } from '#/db/schema.ts'

import type { Conversation, ConversationMessage } from './model.ts'
import {
  mergeAccountConversations,
  relationOf,
  replyAccountsFor,
} from './merge.ts'
import type { AccountConversation, ConnectedAccount } from './merge.ts'

const A = { id: 'a@example.com', email: 'a@example.com' }
const B = { id: 'b@example.com', email: 'b@example.com' }
const ACCOUNTS: ConnectedAccount[] = [A, B]

const ALICE: Participant = { name: 'Alice', email: 'alice@example.com' }

function message(
  overrides: Partial<ConversationMessage> & { from: Participant },
): ConversationMessage {
  return {
    gmailMessageId: 'msg',
    internetMessageId: null,
    to: [],
    cc: [],
    subject: 'Subject',
    snippet: null,
    body: 'Body',
    bodyHtml: null,
    greeting: null,
    signature: null,
    isFromOwner: false,
    sentAt: new Date('2026-01-01T10:00:00Z'),
    ...overrides,
  }
}

function conversation(
  overrides: Partial<Conversation> & { messages: ConversationMessage[] },
): Conversation {
  return {
    id: 'conversation',
    gmailThreadId: 'thread',
    subject: 'Subject',
    participants: [],
    attachments: [],
    state: 'informational',
    isAutomated: false,
    replyable: true,
    awaitingReply: false,
    requiresReply: false,
    importance: 5,
    urgency: 5,
    intent: 'unknown',
    messageCount: overrides.messages.length,
    attachmentCount: 0,
    lastMessageAt: overrides.messages.at(-1)?.sentAt ?? new Date(0),
    topic: null,
    goal: null,
    ...overrides,
  }
}

function source(accountId: string, conv: Conversation): AccountConversation {
  return { accountId, conversation: conv }
}

describe('relationOf', () => {
  test('both addresses addressed is between-your-accounts', () => {
    expect(relationOf([message({ from: ALICE, to: [A, B] })], ACCOUNTS)).toBe(
      'between-your-accounts',
    )
  })

  test('a correspondent plus a mere copy is primary', () => {
    expect(
      relationOf([message({ from: ALICE, to: [A], cc: [B] })], ACCOUNTS),
    ).toBe('primary')
  })

  test('only copies is cc-only', () => {
    expect(relationOf([message({ from: ALICE, cc: [A, B] })], ACCOUNTS)).toBe(
      'cc-only',
    )
  })

  test('a direct sighting outranks a copy, wherever it appears', () => {
    // B is on the CC of the first message but addressed on the second.
    expect(
      relationOf(
        [
          message({ from: ALICE, to: [A], cc: [B] }),
          message({ from: ALICE, to: [B] }),
        ],
        ACCOUNTS,
      ),
    ).toBe('between-your-accounts')
  })
})

describe('mergeAccountConversations', () => {
  test('folds the same thread from two mailboxes into one row', () => {
    const shared = '<shared@example.com>'
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            gmailThreadId: 't1',
            messages: [
              message({
                gmailMessageId: 'a1',
                internetMessageId: shared,
                from: ALICE,
                to: [A, B],
              }),
            ],
          }),
        ),
        source(
          B.id,
          conversation({
            id: `${B.id}:t2`,
            gmailThreadId: 't2',
            messages: [
              message({
                gmailMessageId: 'b1',
                internetMessageId: shared,
                from: ALICE,
                to: [A, B],
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(merged).toHaveLength(1)
    const row = merged[0]
    expect(row.relation).toBe('between-your-accounts')
    expect(row.conversation.messages).toHaveLength(1)
    expect(row.sourceAccountIds).toEqual([A.id, B.id])
  })

  test('keeps conversations that share no Message-ID apart', () => {
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            messages: [
              message({
                internetMessageId: '<one@example.com>',
                from: ALICE,
                to: [A],
              }),
            ],
          }),
        ),
        source(
          B.id,
          conversation({
            id: `${B.id}:t2`,
            messages: [
              message({
                internetMessageId: '<two@example.com>',
                from: ALICE,
                to: [B],
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(merged).toHaveLength(2)
  })

  test('a message from the other address counts as mine', () => {
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            messages: [
              message({
                gmailMessageId: 'm1',
                internetMessageId: '<m1@example.com>',
                from: ALICE,
                to: [A],
              }),
              // Written from the user's *other* connected mailbox.
              message({
                gmailMessageId: 'm2',
                internetMessageId: '<m2@example.com>',
                from: { name: 'Me', email: B.email },
                to: [ALICE, A],
                sentAt: new Date('2026-01-01T11:00:00Z'),
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    const messages = merged[0]?.conversation.messages ?? []
    expect(messages[0]?.isFromOwner).toBe(false)
    expect(messages[1]?.isFromOwner).toBe(true)
    // We spoke last from the other address, so the ball is in their court.
    expect(merged[0]?.conversation.awaitingReply).toBe(true)
  })

  test('routes a reply through the owning account and allows picking another', () => {
    const shared = '<shared@example.com>'
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            messages: [
              message({
                internetMessageId: shared,
                from: { name: 'Me', email: A.email },
                to: [B, ALICE],
                sentAt: new Date('2026-01-01T09:00:00Z'),
              }),
            ],
          }),
        ),
        source(
          B.id,
          conversation({
            id: `${B.id}:t2`,
            messages: [
              message({
                internetMessageId: shared,
                from: { name: 'Me', email: A.email },
                to: [B, ALICE],
                sentAt: new Date('2026-01-01T09:00:00Z'),
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    // A wrote to B, so the reply leaves from B by default.
    expect(merged[0]?.ownerAccountId).toBe(B.id)
    expect(merged[0]?.replyAccountIds).toEqual([B.id, A.id])
  })

  test('a mere copy is annotated, never the owner', () => {
    const shared = '<shared@example.com>'
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            messages: [
              message({
                internetMessageId: shared,
                from: ALICE,
                to: [A],
                cc: [B],
              }),
            ],
          }),
        ),
        source(
          B.id,
          conversation({
            id: `${B.id}:t2`,
            messages: [
              message({
                internetMessageId: shared,
                from: ALICE,
                to: [A],
                cc: [B],
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]?.relation).toBe('primary')
    expect(merged[0]?.ownerAccountId).toBe(A.id)
    expect(merged[0]?.ccAccountIds).toEqual([B.id])
  })

  test('a thread only copied to both addresses is ranked low, not actionable', () => {
    const shared = '<shared@example.com>'
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            messages: [
              message({
                internetMessageId: shared,
                from: ALICE,
                to: [{ name: 'Carol', email: 'carol@example.com' }],
                cc: [A, B],
                body: 'Could you please confirm?',
              }),
            ],
          }),
        ),
        source(
          B.id,
          conversation({
            id: `${B.id}:t2`,
            messages: [
              message({
                internetMessageId: shared,
                from: ALICE,
                to: [{ name: 'Carol', email: 'carol@example.com' }],
                cc: [A, B],
                body: 'Could you please confirm?',
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(merged[0]?.relation).toBe('cc-only')
    expect(merged[0]?.conversation.state).toBe('low-priority')
    expect(merged[0]?.conversation.requiresReply).toBe(false)
  })

  test('collapses a shared attachment instead of showing it twice', () => {
    const shared = '<shared@example.com>'
    const attachment = {
      gmailMessageId: 'm1',
      messageId: 'm1',
      gmailAttachmentId: 'att-1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      isInline: false,
      contentId: null,
    }

    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            messages: [
              message({ internetMessageId: shared, from: ALICE, to: [A, B] }),
            ],
            attachments: [attachment],
          }),
        ),
        source(
          B.id,
          conversation({
            id: `${B.id}:t2`,
            messages: [
              message({ internetMessageId: shared, from: ALICE, to: [A, B] }),
            ],
            attachments: [{ ...attachment, gmailAttachmentId: 'att-2' }],
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(merged[0]?.conversation.attachments).toHaveLength(1)
    expect(merged[0]?.conversation.attachmentCount).toBe(1)
  })
})

describe('replyAccountsFor', () => {
  test('lists the owning account first, then the rest of mine', () => {
    const accounts = replyAccountsFor(
      [message({ from: ALICE, to: [A], cc: [B] })],
      ACCOUNTS,
      A.id,
    )

    expect(accounts).toEqual([A.id, B.id])
  })
})
