import { describe, expect, test } from 'bun:test'

import type { Participant } from '#/db/schema.ts'

import type { Conversation, ConversationMessage } from './model.ts'
import {
  mergeAccountConversations,
  partitionByState,
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
    providerMessageId: 'msg',
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
    providerThreadId: 'thread',
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
    // Last, so `Partial<Conversation>` cannot leave them undefined: a case may
    // supply a stored call, reading or Done mark, and every other case means
    // "none".
    stateOverride: overrides.stateOverride ?? null,
    seenAt: overrides.seenAt ?? null,
    done: overrides.done ?? null,
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
  test('a no-reply verdict survives the merge rather than being re-derived', () => {
    // The mark the user set on a sender, or Jev's own reading of the thread, is
    // a decision — and the merge is a second mailbox's copy of the same mail, not
    // new evidence. Recomputing it here would put a reply box back on a thread
    // the user said cannot be answered, which is exactly what happened before
    // this rule existed.
    const shared = '<shared@example.com>'
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            providerThreadId: 't1',
            replyable: false,
            isAutomated: false,
            state: 'low-priority',
            messages: [
              message({
                providerMessageId: 'a1',
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
            providerThreadId: 't2',
            replyable: true,
            messages: [
              message({
                providerMessageId: 'b1',
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
    expect(merged[0].conversation.replyable).toBe(false)
  })

  test('reading the thread in either mailbox reads as read in the merge', () => {
    // Two mailboxes holding overlapping copies of one thread are the same mail.
    // Taking only the canonical row's mark would show the whole thread unread
    // again the moment it was read in the other mailbox.
    const shared = '<read@example.com>'
    const read = new Date('2026-02-02T12:00:00Z')
    const messages = [
      message({
        providerMessageId: 'a1',
        internetMessageId: shared,
        from: ALICE,
        to: [A, B],
      }),
    ]

    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            providerThreadId: 't1',
            seenAt: null,
            messages,
          }),
        ),
        source(
          B.id,
          conversation({
            id: `${B.id}:t2`,
            providerThreadId: 't2',
            seenAt: read,
            messages,
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(merged).toHaveLength(1)
    expect(merged[0].conversation.seenAt?.toISOString()).toBe(
      read.toISOString(),
    )
  })

  test('a done mark is carried until the union has moved past it', () => {
    // Carried: a merge is a second copy of the same mail, not new evidence, so it
    // must not silently drop the user's own call — which is the shape the bug
    // takes, because the mark only exists on one of the two rows.
    const shared = '<done@example.com>'
    const mark = {
      doneAt: new Date('2026-02-02T12:00:00Z'),
      messageAt: new Date('2026-02-01T12:00:00Z'),
    }

    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            providerThreadId: 't1',
            done: mark,
            messages: [
              message({
                providerMessageId: 'a1',
                internetMessageId: shared,
                from: ALICE,
                to: [A, B],
                sentAt: new Date('2026-02-01T12:00:00Z'),
              }),
            ],
          }),
        ),
        source(
          B.id,
          conversation({
            id: `${B.id}:t2`,
            providerThreadId: 't2',
            messages: [
              message({
                providerMessageId: 'b1',
                internetMessageId: shared,
                from: ALICE,
                to: [A, B],
                sentAt: new Date('2026-02-01T12:00:00Z'),
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(merged[0].conversation.done).toEqual(mark)

    // And dropped once the union contains mail the mark never covered, so a
    // thread that came back in one mailbox comes back in the merged view too.
    const outrun = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            providerThreadId: 't1',
            done: mark,
            messages: [
              message({
                providerMessageId: 'a1',
                internetMessageId: shared,
                from: ALICE,
                to: [A, B],
                sentAt: new Date('2026-02-01T12:00:00Z'),
              }),
            ],
          }),
        ),
        source(
          B.id,
          conversation({
            id: `${B.id}:t2`,
            providerThreadId: 't2',
            messages: [
              message({
                providerMessageId: 'b1',
                internetMessageId: shared,
                from: ALICE,
                to: [A, B],
                sentAt: new Date('2026-02-03T09:00:00Z'),
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(outrun[0].conversation.done).toBeNull()
  })

  test('machine mail is recomputed from the union, so a human answer reopens it', () => {
    // The other half of the rule above: a no-reply verdict that came from the
    // *marker* is not a decision and is not carried. `isAutomatedThread` exists to
    // let a thread a human finally replies to become a conversation again, and a
    // merge that carried the old verdict would defeat that.
    const shared = '<robot@example.com>'
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            providerThreadId: 't1',
            replyable: false,
            isAutomated: true,
            messages: [
              message({
                providerMessageId: 'a1',
                internetMessageId: shared,
                from: { name: 'GitHub', email: 'noreply@github.com' },
                to: [A],
              }),
              message({
                providerMessageId: 'a2',
                internetMessageId: '<answer@example.com>',
                from: ALICE,
                to: [A],
                sentAt: new Date('2026-01-02T10:00:00Z'),
              }),
            ],
          }),
        ),
        source(
          B.id,
          conversation({
            id: `${B.id}:t2`,
            providerThreadId: 't2',
            messages: [
              message({
                providerMessageId: 'b1',
                internetMessageId: shared,
                from: { name: 'GitHub', email: 'noreply@github.com' },
                to: [B],
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(merged).toHaveLength(1)
    expect(merged[0].conversation.isAutomated).toBe(false)
    expect(merged[0].conversation.replyable).toBe(true)
  })

  test('folds the same thread from two mailboxes into one row', () => {
    const shared = '<shared@example.com>'
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            providerThreadId: 't1',
            messages: [
              message({
                providerMessageId: 'a1',
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
            providerThreadId: 't2',
            messages: [
              message({
                providerMessageId: 'b1',
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
                providerMessageId: 'm1',
                internetMessageId: '<m1@example.com>',
                from: ALICE,
                to: [A],
              }),
              // Written from the user's *other* connected mailbox.
              message({
                providerMessageId: 'm2',
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
      providerMessageId: 'm1',
      messageId: 'm1',
      providerAttachmentId: 'att-1',
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
            attachments: [{ ...attachment, providerAttachmentId: 'att-2' }],
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(merged[0]?.conversation.attachments).toHaveLength(1)
    expect(merged[0]?.conversation.attachmentCount).toBe(1)
  })

  test('keeps media copies from each mailbox for content-hash deduplication', () => {
    const shared = '<shared-media@example.com>'
    const image = {
      providerMessageId: 'm1',
      messageId: 'm1',
      providerAttachmentId: 'image-a',
      filename: 'logo.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      isInline: true,
      contentId: 'logo',
    }
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:media1`,
            providerThreadId: 'media1',
            messages: [
              message({ internetMessageId: shared, from: ALICE, to: [A, B] }),
            ],
            attachments: [image],
          }),
        ),
        source(
          B.id,
          conversation({
            id: `${B.id}:media2`,
            providerThreadId: 'media2',
            messages: [
              message({ internetMessageId: shared, from: ALICE, to: [A, B] }),
            ],
            attachments: [
              {
                ...image,
                providerAttachmentId: 'image-b',
                filename: 'renamed.png',
              },
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(merged[0]?.conversation.attachments).toHaveLength(2)
    expect(
      new Set(
        merged[0]?.conversation.attachments.map(
          (attachment) => attachment.providerThreadId,
        ),
      ),
    ).toEqual(new Set(['media1', 'media2']))
  })
})

/**
 * What the inbox shows, which is not quite what the rows say.
 *
 * A done thread is out of the state groups: the heading "Needs action" over a
 * thread the user has already handled is exactly the confusion this split exists
 * to remove. The state is still on the row — the tag shows it, faintly — so this
 * is a presentation rule, and it lives in one place rather than in the view.
 */
describe('partitionByState', () => {
  const mark = {
    doneAt: new Date('2026-01-01T12:00:00Z'),
    messageAt: new Date('2026-01-01T10:00:00Z'),
  }

  function openThread(id: string, messageId: string) {
    return source(
      A.id,
      conversation({
        id: `${A.id}:${id}`,
        providerThreadId: id,
        state: 'needs-action',
        messages: [
          message({
            providerMessageId: messageId,
            internetMessageId: `<${messageId}@example.com>`,
            from: ALICE,
            to: [A],
          }),
        ],
      }),
    )
  }

  test('a done thread leaves its group and is counted apart', () => {
    const rows = mergeAccountConversations(
      [
        openThread('t1', 'm1'),
        source(
          A.id,
          conversation({
            id: `${A.id}:t2`,
            providerThreadId: 't2',
            state: 'needs-action',
            done: mark,
            messages: [
              message({
                providerMessageId: 'm2',
                internetMessageId: '<m2@example.com>',
                from: ALICE,
                to: [A],
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    const { counts, doneCount } = partitionByState(rows)

    // Two threads were filed as work; one of them the user has finished with, so
    // only one is still work.
    expect(counts['needs-action']).toBe(1)
    expect(doneCount).toBe(1)
  })

  test('a done thread that has since received mail counts as work again', () => {
    const rows = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            providerThreadId: 't1',
            state: 'needs-action',
            done: mark,
            messages: [
              message({
                providerMessageId: 'm1',
                internetMessageId: '<m1@example.com>',
                from: ALICE,
                to: [A],
                // Newer than the mark: the thread has come back.
                sentAt: new Date('2026-01-02T10:00:00Z'),
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    const { counts, doneCount } = partitionByState(rows)

    expect(doneCount).toBe(0)
    expect(counts['needs-action']).toBe(1)
  })
})

describe('a merged thread keeps the stored decision', () => {
  const shared = '<shared@example.com>'

  test('does not re-derive state, importance or urgency with the rules', () => {
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            providerThreadId: 't1',
            state: 'needs-action',
            requiresReply: true,
            importance: 9,
            urgency: 8,
            messages: [
              message({
                providerMessageId: 'a1',
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
            providerThreadId: 't2',
            messages: [
              message({
                providerMessageId: 'b1',
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

    // A plain body, so the rules alone would have said `informational`. The
    // pipeline's answer is what the merged row has to agree with.
    expect(merged[0]?.conversation.state).toBe('needs-action')
    expect(merged[0]?.conversation.importance).toBe(9)
    expect(merged[0]?.conversation.urgency).toBe(8)
  })

  test('but a certain rule from the union still wins', () => {
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            providerThreadId: 't1',
            state: 'needs-action',
            requiresReply: true,
            messages: [
              message({
                providerMessageId: 'a1',
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
            providerThreadId: 't2',
            messages: [
              message({
                providerMessageId: 'b1',
                internetMessageId: shared,
                from: ALICE,
                to: [A, B],
              }),
              // The user answered it from their other mailbox, so the stored
              // `needs-action` on the owner's row is simply out of date.
              message({
                providerMessageId: 'b2',
                internetMessageId: '<b2@example.com>',
                from: { name: 'Me', email: B.email },
                to: [ALICE],
                sentAt: new Date('2026-01-01T12:00:00Z'),
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(merged[0]?.conversation.awaitingReply).toBe(true)
    expect(merged[0]?.conversation.state).toBe('waiting-for-reply')
  })

  test('keeps the user’s own call on the state, alongside the call itself', () => {
    // The call is stored on one mailbox's row, but the row the user sees is the
    // merged one — both the state and the call it came from have to survive the
    // merge, or the "Restore" control has nothing to restore.
    const saidAt = new Date('2026-01-01T10:00:00Z')
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            providerThreadId: 't1',
            state: 'low-priority',
            stateOverride: { state: 'low-priority', messageAt: saidAt },
            messages: [
              message({
                providerMessageId: 'a1',
                internetMessageId: shared,
                from: ALICE,
                to: [A, B],
                sentAt: saidAt,
              }),
            ],
          }),
        ),
        source(
          B.id,
          conversation({
            id: `${B.id}:t2`,
            providerThreadId: 't2',
            messages: [
              message({
                providerMessageId: 'b1',
                internetMessageId: shared,
                from: ALICE,
                to: [A, B],
                sentAt: saidAt,
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(merged[0]?.conversation.state).toBe('low-priority')
    expect(merged[0]?.conversation.stateOverride?.state).toBe('low-priority')
  })

  test('drops a call the union has outrun', () => {
    // Said before the other mailbox received Alice's follow-up. The judgement
    // was about the earlier mail, so it does not carry over to the newer one.
    const merged = mergeAccountConversations(
      [
        source(
          A.id,
          conversation({
            id: `${A.id}:t1`,
            providerThreadId: 't1',
            state: 'low-priority',
            stateOverride: {
              state: 'low-priority',
              messageAt: new Date('2026-01-01T10:00:00Z'),
            },
            messages: [
              message({
                providerMessageId: 'a1',
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
            providerThreadId: 't2',
            messages: [
              message({
                providerMessageId: 'b1',
                internetMessageId: shared,
                from: ALICE,
                to: [A, B],
              }),
              message({
                providerMessageId: 'b2',
                internetMessageId: '<b2@example.com>',
                from: ALICE,
                to: [B],
                body: 'Can you confirm Tuesday?',
                sentAt: new Date('2026-01-02T09:00:00Z'),
              }),
            ],
          }),
        ),
      ],
      ACCOUNTS,
    )

    expect(merged[0]?.conversation.state).toBe('needs-action')
    expect(merged[0]?.conversation.stateOverride).toBeNull()
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
