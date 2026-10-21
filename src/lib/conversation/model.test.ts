import { describe, expect, test } from 'bun:test'

import {
  activeDone,
  buildConversation,
  cleanMessage,
  conversationId,
  deriveState,
  inferIntent,
  isSenderAddress,
  normaliseEmail,
  resolveReplyStyle,
  strippedReplyPrefix,
  toParticipant,
  unseenMessages,
} from './model.ts'
import {
  applyDecision,
  decideConversation,
  HeuristicRuleClassifier,
  NoTopicGenerator,
  PlaceholderDecisionModel,
} from './decision.ts'
import type { DecisionInput } from './decision.ts'
import { parseRawMessage } from '#/lib/mail/index.ts'
import type { ParsedMessage } from '#/lib/mail/index.ts'

const OWNER = 'me@example.com'

/** Build a raw message and parse it, the way the Gmail adapter would. */
async function msg(raw: string): Promise<ParsedMessage> {
  return parseRawMessage(raw)
}

function rawMessage(args: {
  from: string
  to?: string
  subject: string
  date: string
  body: string
  messageId: string
}): string {
  return [
    `From: ${args.from}`,
    `To: ${args.to ?? OWNER}`,
    `Subject: ${args.subject}`,
    `Date: ${args.date}`,
    `Message-ID: ${args.messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    args.body,
  ].join('\r\n')
}

describe('toParticipant', () => {
  test('splits a display name from the address', () => {
    expect(toParticipant('Sarah Chen <Sarah@Example.com>')).toEqual({
      name: 'Sarah Chen',
      email: 'sarah@example.com',
    })
  })

  test('handles a bare address', () => {
    expect(toParticipant('bob@example.com')).toEqual({
      name: null,
      email: 'bob@example.com',
    })
  })

  test('strips surrounding quotes on the display name', () => {
    expect(toParticipant('"Chen, Sarah" <s@e.com>').name).toBe('Chen, Sarah')
  })
})

/**
 * "Done" and "seen" are deliberately two different questions.
 *
 * `activeDone` is whether the user's own call still stands; `unseenMessages` is
 * what they have not looked at. Keeping them apart is what stops a read thread
 * from looking handled — the case where a reply gets forgotten.
 */
describe('activeDone', () => {
  const done = {
    doneAt: new Date('2026-02-02T12:00:00Z'),
    messageAt: new Date('2026-02-01T12:00:00Z'),
  }

  test('returns when the mark was made, while it is still current', () => {
    expect(
      activeDone({ done, lastMessageAt: new Date('2026-02-01T12:00:00Z') }),
    ).toEqual(done.doneAt)
  })

  test('a thread that has moved on is no longer done', () => {
    // Newer mail voids the mark, exactly as it voids a state override: the user
    // said "done" about the messages that existed then, and this is not those.
    expect(
      activeDone({ done, lastMessageAt: new Date('2026-02-03T09:00:00Z') }),
    ).toBeNull()
  })

  test('no mark at all is not a done thread', () => {
    expect(
      activeDone({ done: null, lastMessageAt: new Date('2026-02-03T09:00:00Z') }),
    ).toBeNull()
  })
})

describe('unseenMessages', () => {
  function from(iso: string, isFromOwner: boolean) {
    return {
      providerMessageId: iso + String(isFromOwner),
      internetMessageId: null,
      from: { email: isFromOwner ? OWNER : 'alice@example.com', name: null },
      to: [],
      cc: [],
      subject: 'Subject',
      snippet: null,
      body: 'Body',
      bodyHtml: null,
      greeting: null,
      signature: null,
      isFromOwner,
      sentAt: new Date(iso),
    }
  }

  test('everything is unseen until the thread has been opened', () => {
    const messages = [from('2026-02-01T10:00:00Z', false)]
    expect(unseenMessages({ messages, seenAt: null })).toHaveLength(1)
  })

  test('only mail newer than the mark counts', () => {
    const messages = [
      from('2026-02-01T10:00:00Z', false),
      from('2026-02-02T10:00:00Z', false),
    ]

    expect(
      unseenMessages({
        messages,
        seenAt: new Date('2026-02-01T10:00:00Z'),
      }).map((m) => m.sentAt.toISOString()),
    ).toEqual(['2026-02-02T10:00:00.000Z'])
  })

  test('the user’s own reply is never unseen', () => {
    // Otherwise sending a reply from here would leave the thread looking unread
    // to the person who just wrote it.
    const messages = [
      from('2026-02-01T10:00:00Z', false),
      from('2026-02-02T10:00:00Z', true),
    ]

    expect(
      unseenMessages({
        messages,
        seenAt: new Date('2026-02-01T10:00:00Z'),
      }),
    ).toHaveLength(0)
  })
})

/**
 * The shape rule behind the can't-reply list in Settings.
 *
 * The list is typed rather than picked from a thread, so this is what stands
 * between the box and a stored preference for an address that cannot exist.
 */
describe('isSenderAddress', () => {
  test('accepts the ordinary forms and lowercases them', () => {
    expect(isSenderAddress('updates@acme.example')).toBe(true)
    expect(isSenderAddress('  Updates@Acme.Example  ')).toBe(true)
    // A local address has no dot in the domain, and is still an address: the
    // rule only has to reject what could never be one.
    expect(isSenderAddress('invoice@localhost')).toBe(true)
    expect(normaliseEmail(' Updates@Acme.Example ')).toBe(
      'updates@acme.example',
    )
  })

  test('rejects what could never be an address', () => {
    expect(isSenderAddress('')).toBe(false)
    expect(isSenderAddress('   ')).toBe(false)
    expect(isSenderAddress('updates@')).toBe(false)
    expect(isSenderAddress('@acme.example')).toBe(false)
    expect(isSenderAddress('nope')).toBe(false)
    // Two addresses pasted at once, or a whole header line.
    expect(isSenderAddress('a@b.example c@d.example')).toBe(false)
    expect(isSenderAddress('From: Acme <updates@acme.example>')).toBe(false)
    // Two `@` signs: not an address, however plausible it looks.
    expect(isSenderAddress('a@b@c.example')).toBe(false)
  })

  test('rejects an address past the RFC length ceiling', () => {
    const long = `${'a'.repeat(310)}@acme.example`
    expect(long.length).toBeGreaterThan(320)
    expect(isSenderAddress(long)).toBe(false)
  })
})

describe('strippedReplyPrefix', () => {
  test('removes Re: and Fwd: chains', () => {
    expect(strippedReplyPrefix('Re: Fwd: Project launch')).toBe(
      'Project launch',
    )
    expect(strippedReplyPrefix('RE: RE: Quarterly numbers')).toBe(
      'Quarterly numbers',
    )
    expect(strippedReplyPrefix('AW: Topic')).toBe('Topic')
  })

  test('leaves a plain subject alone', () => {
    expect(strippedReplyPrefix('Project launch')).toBe('Project launch')
  })

  test('handles the Outlook [2] suffix', () => {
    expect(strippedReplyPrefix('RE[2]: Numbers')).toBe('Numbers')
  })
})

describe('buildConversation', () => {
  test('builds a conversation from a thread', async () => {
    const messages = await Promise.all([
      msg(
        rawMessage({
          from: 'Sarah Chen <sarah@example.com>',
          subject: 'Project launch',
          date: 'Mon, 15 Jan 2024 10:00:00 +0100',
          messageId: '<m1@e.com>',
          body: 'Hi Alex,\n\nCan we move the launch to Tuesday?\n\nThanks,\nSarah',
        }),
      ),
      msg(
        rawMessage({
          from: OWNER,
          subject: 'Re: Project launch',
          date: 'Mon, 15 Jan 2024 11:00:00 +0100',
          messageId: '<m2@e.com>',
          body: 'Wednesday would work for me.',
        }),
      ),
    ])

    const conversation = buildConversation(messages, {
      ownerEmail: OWNER,
      providerThreadId: 'thread-1',
    })

    expect(conversation.providerThreadId).toBe('thread-1')
    expect(conversation.subject).toBe('Project launch')
    expect(conversation.messageCount).toBe(2)
    expect(conversation.id).toBe(conversationId(OWNER, 'thread-1'))
  })

  test('sorts messages by date regardless of input order', async () => {
    const later = await msg(
      rawMessage({
        from: OWNER,
        subject: 'Re: X',
        date: 'Tue, 16 Jan 2024 10:00:00 +0000',
        messageId: '<m2@e.com>',
        body: 'Second message.',
      }),
    )
    const earlier = await msg(
      rawMessage({
        from: 'sarah@example.com',
        subject: 'X',
        date: 'Mon, 15 Jan 2024 10:00:00 +0000',
        messageId: '<m1@e.com>',
        body: 'First message.',
      }),
    )

    // Deliberately out of order.
    const conversation = buildConversation([later, earlier], {
      ownerEmail: OWNER,
      providerThreadId: 't',
    })

    expect(conversation.messages[0].body).toContain('First')
    expect(conversation.messages[1].body).toContain('Second')
    expect(conversation.lastMessageAt.toISOString()).toContain('2024-01-16')
  })

  test('per-sender preferences restore detected greeting/signature and keep quotes', async () => {
    const parsed = await msg(
      rawMessage({
        from: 'Alice <alice@example.com>',
        subject: 'Project',
        date: 'Mon, 15 Jan 2024 10:00:00 +0000',
        messageId: '<profile@example.com>',
        body: 'Hi Alex,\n\nMy reply.\n\nBest,\nAlice\n\nOn Monday Alex wrote:\n> Original.',
      }),
    )
    const conversation = buildConversation([parsed], {
      ownerEmail: OWNER,
      providerThreadId: 'profile-thread',
      parsingPreferences: {
        'alice@example.com': {
          stripQuotedHistory: false,
          stripGreeting: false,
          stripSignature: false,
        },
      },
      replyStyles: {
        account: { greeting: 'Hello,', signature: 'Regards,\nMe' },
        senders: {},
      },
    })

    const result = conversation.messages[0]
    expect(result.body).toContain('Hi Alex,')
    expect(result.body).toContain('On Monday Alex wrote:')
    expect(result.body).toContain('Best,')
    expect(result.strippedQuote).toBeNull()
    expect(result.detectedGreeting).toBe('Hi Alex,')
    expect(result.replyGreeting).toBe('Hello,')
    expect(result.replySignature).toBe('Regards,\nMe')
  })

  test('cleans each message for chat display', async () => {
    const messages = await Promise.all([
      msg(
        rawMessage({
          from: 'Sarah Chen <sarah@example.com>',
          subject: 'Project launch',
          date: 'Mon, 15 Jan 2024 10:00:00 +0100',
          messageId: '<m1@e.com>',
          body: 'Hi Alex,\n\nTuesday works for me.\n\nThanks,\nSarah\n\nOn Sun, 14 Jan Alex wrote:\n> Can we move it?',
        }),
      ),
    ])

    const conversation = buildConversation(messages, {
      ownerEmail: OWNER,
      providerThreadId: 't',
    })

    const m = conversation.messages[0]
    expect(m.body).toBe('Tuesday works for me.')
    expect(m.greeting).toBe('Hi Alex,')
    expect(m.signature).toContain('Thanks')
    expect(m.isFromOwner).toBe(false)
  })

  test('marks the owner as sender by case-insensitive email comparison', async () => {
    const messages = await Promise.all([
      msg(
        rawMessage({
          from: 'ME@Example.com',
          subject: 'X',
          date: 'Mon, 15 Jan 2024 10:00:00 +0000',
          messageId: '<m1@e.com>',
          body: 'Mine.',
        }),
      ),
    ])

    const conversation = buildConversation(messages, {
      ownerEmail: 'me@example.com',
      providerThreadId: 't',
    })

    expect(conversation.messages[0].isFromOwner).toBe(true)
  })

  test('dedupes participants and excludes empty addresses', async () => {
    const messages = await Promise.all([
      msg(
        rawMessage({
          from: 'Sarah <sarah@example.com>',
          to: `${OWNER}, Sarah <Sarah@Example.com>`,
          subject: 'X',
          date: 'Mon, 15 Jan 2024 10:00:00 +0000',
          messageId: '<m1@e.com>',
          body: 'Hello.',
        }),
      ),
    ])

    const conversation = buildConversation(messages, {
      ownerEmail: OWNER,
      providerThreadId: 't',
    })

    const emails = conversation.participants.map((p) => p.email)
    expect(new Set(emails).size).toBe(emails.length)
    expect(emails).toContain('sarah@example.com')
    expect(emails).toContain('me@example.com')
  })

  test('leaves topic and goal null for the user and decision layer to fill', async () => {
    const messages = await Promise.all([
      msg(
        rawMessage({
          from: 'sarah@example.com',
          subject: 'Project launch',
          date: 'Mon, 15 Jan 2024 10:00:00 +0000',
          messageId: '<m1@e.com>',
          body: 'Hello.',
        }),
      ),
    ])

    const conversation = buildConversation(messages, {
      ownerEmail: OWNER,
      providerThreadId: 't',
    })

    expect(conversation.topic).toBeNull()
    expect(conversation.goal).toBeNull()
  })

  test('handles an empty thread without throwing', () => {
    const conversation = buildConversation([], {
      ownerEmail: OWNER,
      providerThreadId: 't',
    })
    expect(conversation.messageCount).toBe(0)
    expect(conversation.state).toBe('informational')
    expect(conversation.subject).toBe('No subject')
  })

  test('collects attachments across the thread', async () => {
    const messages = await Promise.all([
      msg(
        [
          `From: ${OWNER}`,
          `To: sarah@example.com`,
          'Subject: Report',
          'Date: Tue, 23 Jan 2024 10:00:00 +0000',
          'MIME-Version: 1.0',
          'Content-Type: multipart/mixed; boundary="B"',
          '',
          '--B',
          'Content-Type: text/plain; charset="UTF-8"',
          '',
          'Report attached.',
          '',
          '--B',
          'Content-Type: application/pdf; name="q1.pdf"',
          'Content-Disposition: attachment; filename="q1.pdf"',
          'Content-Transfer-Encoding: base64',
          '',
          'JVBERi0=',
          '',
          '--B--',
        ].join('\r\n'),
      ),
    ])

    const conversation = buildConversation(messages, {
      ownerEmail: OWNER,
      providerThreadId: 't',
    })

    expect(conversation.attachmentCount).toBe(1)
    expect(conversation.attachments[0].filename).toBe('q1.pdf')
    expect(conversation.attachments[0].mimeType).toBe('application/pdf')
  })
})

describe('deriveState', () => {
  const now = new Date('2024-01-16T12:00:00Z')

  test('marks needs-action when they ask us a direct question', () => {
    const result = deriveState(
      [
        {
          isFromOwner: false,
          sentAt: now,
          body: 'Can you send me the numbers?',
        },
      ],
      { ownerEmail: OWNER, lastMessageAt: now, now },
    )

    expect(result.state).toBe('needs-action')
    expect(result.requiresReply).toBe(true)
    expect(result.awaitingReply).toBe(false)
  })

  test('marks waiting-for-reply when we spoke last', () => {
    const result = deriveState(
      [{ isFromOwner: true, sentAt: now, body: 'Sent it over.' }],
      { ownerEmail: OWNER, lastMessageAt: now, now },
    )

    expect(result.state).toBe('waiting-for-reply')
    expect(result.awaitingReply).toBe(true)
  })

  test('marks informational when they sent an update', () => {
    const result = deriveState(
      [
        {
          isFromOwner: false,
          sentAt: now,
          body: 'FYI the meeting moved to 3pm.',
        },
      ],
      { ownerEmail: OWNER, lastMessageAt: now, now },
    )

    expect(result.state).toBe('informational')
  })

  test('does not treat a statement ending in a question mark as a request', () => {
    const result = deriveState(
      [
        {
          isFromOwner: false,
          sentAt: now,
          body: 'Wondering how the weather is?',
        },
      ],
      { ownerEmail: OWNER, lastMessageAt: now, now },
    )

    expect(result.requiresReply).toBe(false)
  })

  test('does not read bulk-mail furniture as a request', () => {
    // Every one of these filed a thread under `needs-action` before the footer
    // lines were excluded, and none of them asks the reader for anything.
    const footers = [
      "Big sale this week!\n\nCan't see this email? View it in your browser.",
      'New features shipped. Questions? Please contact support.',
      'Your order 1234 has shipped. Do you have questions? Visit our help centre.',
      "You're receiving this because you signed up. Please unsubscribe here?",
    ]

    for (const body of footers) {
      const result = deriveState(
        [{ isFromOwner: false, sentAt: now, body }],
        { ownerEmail: OWNER, lastMessageAt: now, now },
      )

      expect(result.requiresReply).toBe(false)
      expect(result.state).toBe('informational')
    }
  })

  test('still reads a plain request as one', () => {
    for (const body of [
      'Could you send me the invoice before Friday?',
      'Can we move the launch to Tuesday?',
      'Any chance you could review the draft?',
      'Please send the signed copy back?'
    ]) {
      const result = deriveState(
        [{ isFromOwner: false, sentAt: now, body }],
        { ownerEmail: OWNER, lastMessageAt: now, now },
      )

      expect(result.requiresReply).toBe(true)
    }
  })

  test('decays urgency as a conversation ages', () => {
    const recent = deriveState(
      [{ isFromOwner: false, sentAt: now, body: 'Just checking in.' }],
      { ownerEmail: OWNER, lastMessageAt: now, now },
    )
    const old = deriveState(
      [
        {
          isFromOwner: false,
          sentAt: new Date('2023-01-01T00:00:00Z'),
          body: 'Just checking in.',
        },
      ],
      {
        ownerEmail: OWNER,
        lastMessageAt: new Date('2023-01-01T00:00:00Z'),
        now,
      },
    )

    expect(recent.urgency).toBeGreaterThan(old.urgency)
  })

  test('raises importance for long threads', () => {
    const one = deriveState([{ isFromOwner: true, sentAt: now, body: 'x' }], {
      ownerEmail: OWNER,
      lastMessageAt: now,
      now,
    })
    const many = deriveState(
      Array.from({ length: 6 }, () => ({
        isFromOwner: true,
        sentAt: now,
        body: 'x',
      })),
      { ownerEmail: OWNER, lastMessageAt: now, now },
    )

    expect(many.importance).toBeGreaterThan(one.importance)
  })
})

describe('inferIntent', () => {
  test('classifies common intents', () => {
    expect(
      inferIntent('Your invoice is attached, payment due in 30 days.', false),
    ).toBe('transactional')
    expect(inferIntent('SALE! 50% off everything this weekend.', false)).toBe(
      'promotion',
    )
    expect(inferIntent('Does Tuesday work for a call?', true)).toBe(
      'scheduling',
    )
    expect(inferIntent('Can you send the report?', true)).toBe('request')
    expect(inferIntent('Just an update on progress.', false)).toBe('update')
    expect(inferIntent('Something entirely unexpected.', false)).toBe('unknown')
  })
})

/** A decision input with one inbound message, for the classifier tests below. */
function decisionInput(body: string, from = 'sarah@example.com'): DecisionInput {
  return {
    subject: 'Subject',
    messages: [
      {
        providerMessageId: 'm1',
        internetMessageId: null,
        from: { email: from, name: null },
        to: [],
        cc: [],
        subject: 'Subject',
        snippet: null,
        body,
        bodyHtml: null,
        greeting: null,
        signature: null,
        isFromOwner: false,
        sentAt: new Date('2024-01-15T10:00:00Z'),
      },
    ],
    ownerEmail: OWNER,
    goal: null,
    decidedAt: null,
  }
}

/** A pipeline whose model answers with whatever the test needs. */
function pipelineWith(
  verdict: Partial<{
    state: 'needs-action' | 'informational' | 'low-priority' | null
    importance: number
    urgency: number
  }>,
) {
  return {
    rules: new HeuristicRuleClassifier(),
    model: {
      name: 'jev',
      decide: async () => ({
        state: verdict.state ?? null,
        importance: verdict.importance ?? 5,
        urgency: verdict.urgency ?? 5,
        replyable: null,
        reasoning: 'test verdict',
      }),
    },
    topics: new NoTopicGenerator(),
  }
}

describe('decision layer', () => {
  test('the default pipeline classifies a question as needs-action', async () => {
    const decision = await decideConversation({
      subject: 'Project launch',
      messages: [
        {
          providerMessageId: 'm1',
          internetMessageId: null,
          from: { email: 's@e.com', name: 'Sarah' },
          to: [],
          cc: [],
          subject: 'Project launch',
          snippet: null,
          body: 'Can you confirm Tuesday?',
          bodyHtml: null,
          greeting: null,
          signature: null,
          isFromOwner: false,
          sentAt: new Date('2024-01-15T10:00:00Z'),
        },
      ],
      ownerEmail: OWNER,
      goal: null,
      decidedAt: null,
    })

    expect(decision.state).toBe('needs-action')
    expect(decision.reasoning).toBeTruthy()
    // A human wrote it, so it is replyable by default.
    expect(decision.replyable).toBe(true)
    // Rules + placeholder model + no topic generator.
    expect(decision.providers).toEqual(['rules', 'rules', 'none'])
    // No topic generator is configured, so none is invented.
    expect(decision.topic).toBeNull()
  })

  test('with nothing to classify the state falls back to informational', async () => {
    const decision = await decideConversation({
      subject: 'x',
      messages: [],
      ownerEmail: OWNER,
      goal: null,
      decidedAt: null,
    })

    expect(decision.state).toBe('informational')
  })

  test('machine mail ranks low rather than claiming action', async () => {
    // A robot asking for a review is not work the reader can do, and the thread
    // is not replyable either — so `needs-action` was simply wrong for it.
    const decision = await decideConversation(
      decisionInput('Can you review the failing build?', 'no-reply@github.com'),
    )

    expect(decision.state).toBe('low-priority')
    expect(decision.replyable).toBe(false)
  })

  test('a bulk promotion ranks low, and a plain newsletter is informational', async () => {
    // The "?" in a broadcast is a call to action, not a request to the reader.
    const promotion = await decideConversation(
      decisionInput('Do you want to save 20% off? Shop the sale now.'),
    )
    expect(promotion.state).toBe('low-priority')
    expect(promotion.replyable).toBe(true)

    // No marketing signal, so nothing claims `low-priority` — but the footer no
    // longer makes it look like work either.
    const newsletter = await decideConversation(
      decisionInput('New features shipped. Questions? Please contact support.'),
    )
    expect(newsletter.state).toBe('informational')
  })

  test('the decision model can drop a rule that claimed needs-action', async () => {
    const pipeline = pipelineWith({ state: 'informational', importance: 4, urgency: 3 })
    const decision = await decideConversation(
      decisionInput('Can you confirm Tuesday?'),
      pipeline,
    )

    // The rule proposed the action; the model, which read the thread, says no.
    expect(decision.state).toBe('informational')
  })

  test('a thread the model scores as trivial becomes low-priority', async () => {
    const decision = await decideConversation(
      decisionInput('FYI the meeting moved to 3pm.'),
      pipelineWith({ state: 'informational', importance: 2, urgency: 1 }),
    )

    expect(decision.state).toBe('low-priority')
  })

  test('a waiting-for-reply rule is never overridden by the decision model', async () => {
    const decision = await decideConversation(
      {
        subject: 'x',
        messages: [
          {
            providerMessageId: 'm1',
            internetMessageId: null,
            from: { email: OWNER, name: null },
            to: [],
            cc: [],
            subject: 'x',
            snippet: null,
            body: 'Done.',
            bodyHtml: null,
            greeting: null,
            signature: null,
            isFromOwner: true,
            sentAt: new Date('2024-01-15T10:00:00Z'),
          },
        ],
        ownerEmail: OWNER,
        goal: null,
        decidedAt: null,
      },
      {
        rules: new HeuristicRuleClassifier(),
        model: {
          name: 'jev',
          decide: async () => ({
            state: 'needs-action',
            importance: 9,
            urgency: 9,
            replyable: null,
            reasoning: 'model says so',
          }),
        },
        topics: new NoTopicGenerator(),
      },
    )

    // The rules spoke last, so the model's conflicting state is ignored...
    expect(decision.state).toBe('waiting-for-reply')
    // ...but its scores are used, and it is recorded as having run.
    expect(decision.importance).toBe(9)
    expect(decision.providers).toEqual(['rules', 'jev', 'none'])
  })

  test('a notice from a sender the user filed away ranks low, a question does not', async () => {
    // The pattern this exists for: the same website writing the same kind of
    // thing every time. One dismissal should cover all of them.
    const notice = await decideConversation({
      ...decisionInput('Your order has shipped.'),
      ignoredSender: true,
    })
    expect(notice.state).toBe('low-priority')
    expect(notice.reasoning).toBe(
      'You have filed away mail from this sender before.',
    )

    // But if they actually ask something, the thread is work again — the
    // sender's history is not a licence to ignore a question.
    const question = await decideConversation({
      ...decisionInput('Can you confirm the delivery address?'),
      ignoredSender: true,
    })
    expect(question.state).toBe('needs-action')
  })

  test('a sender the user marked as unreachable is not replyable, whatever the model says', async () => {
    // The point of the user's own answer: it is not a signal to be weighed
    // against the model's. A model that would have said "a reply would reach
    // someone" does not get to put the composer back, and `decideConversation`
    // never asks it in the first place (see jev.test.ts).
    const decision = await decideConversation(
      {
        ...decisionInput('Your invoice is ready to view.'),
        unreplyableSender: true,
      },
      {
        rules: new HeuristicRuleClassifier(),
        model: {
          name: 'jev',
          decide: async () => ({
            state: null,
            importance: 5,
            urgency: 5,
            replyable: true,
            reasoning: 'a reply would reach someone',
          }),
        },
        topics: new NoTopicGenerator(),
      },
    )

    expect(decision.replyable).toBe(false)
  })

  test('the mark hides the composer without moving the thread', async () => {
    // "Hide the composer only" is the contract: the user is saying they cannot
    // answer this sender, not that the mail does not matter, so the state stays
    // whatever the decision layer said and the thread stays listed.
    const decision = await decideConversation({
      ...decisionInput('Can you confirm Tuesday?'),
      unreplyableSender: true,
    })

    expect(decision.replyable).toBe(false)
    expect(decision.state).toBe('needs-action')
  })

  test('mail from a filed-away sender still reads as a conversation once answered', async () => {
    const answered = await decideConversation({
      ...decisionInput('Your order has shipped.'),
      ignoredSender: true,
      messages: [
        ...decisionInput('Your order has shipped.').messages,
        {
          providerMessageId: 'm2',
          internetMessageId: null,
          from: { email: OWNER, name: null },
          to: [],
          cc: [],
          subject: 'Subject',
          snippet: null,
          body: 'Where is it?',
          bodyHtml: null,
          greeting: null,
          signature: null,
          isFromOwner: true,
          sentAt: new Date('2024-01-16T10:00:00Z'),
        },
      ],
    })

    // One-way mail is the thing being demoted, so replying to the sender takes
    // the thread out of that category by itself.
    expect(answered.state).toBe('waiting-for-reply')
  })

  test('applyDecision never overwrites the user goal or intent', async () => {
    const messages = await Promise.all([
      msg(
        rawMessage({
          from: 'sarah@example.com',
          subject: 'X',
          date: 'Mon, 15 Jan 2024 10:00:00 +0000',
          messageId: '<m1@e.com>',
          body: 'Hello.',
        }),
      ),
    ])

    const conversation = buildConversation(messages, {
      ownerEmail: OWNER,
      providerThreadId: 't',
    })
    conversation.goal = 'Confirm Tuesday works'
    conversation.intent = 'scheduling'

    const updated = applyDecision(conversation, {
      state: 'needs-action',
      awaitingReply: false,
      requiresReply: true,
      replyable: true,
      importance: 8,
      urgency: 7,
      topic: 'Launch date',
      reasoning: 'test',
      providers: ['test'],
    })

    // The decision's fields apply...
    expect(updated.state).toBe('needs-action')
    expect(updated.topic).toBe('Launch date')
    // ...but the user's goal and intent survive untouched.
    expect(updated.goal).toBe('Confirm Tuesday works')
    expect(updated.intent).toBe('scheduling')
  })

  test('a live user call outranks the decision, and a newer message voids it', async () => {
    const parsed = await Promise.all([
      msg(
        rawMessage({
          from: 'noreply@example.com',
          subject: 'Notice',
          date: 'Mon, 15 Jan 2024 10:00:00 +0000',
          messageId: '<m1@e.com>',
          body: 'Your order has shipped.',
        }),
      ),
    ])
    const decision = {
      state: 'needs-action' as const,
      awaitingReply: false,
      requiresReply: true,
      replyable: true,
      importance: 9,
      urgency: 9,
      topic: null,
      reasoning: 'test',
      providers: ['test'],
    }

    const called = buildConversation(parsed, {
      ownerEmail: OWNER,
      providerThreadId: 't',
    })
    // The call was made against the thread as it stands now.
    called.stateOverride = {
      state: 'low-priority',
      messageAt: called.lastMessageAt,
    }

    const applied = applyDecision(called, decision)
    expect(applied.state).toBe('low-priority')
    // Kept, so a later save cannot lose it.
    expect(applied.stateOverride?.state).toBe('low-priority')
    // Everything the user did not speak to still comes from the decision.
    expect(applied.importance).toBe(9)

    // Now a later message outruns it: the judgement was about what existed at
    // the time, so the decision gets the thread back — and the expired call is
    // dropped rather than left looking current.
    called.lastMessageAt = new Date('2024-01-20T10:00:00Z')
    const reopened = applyDecision(called, decision)
    expect(reopened.state).toBe('needs-action')
    expect(reopened.stateOverride).toBeNull()
  })

  // The AI stages are optional, and the conversation is persisted around this
  // call. A failed request must therefore degrade to the rules rather than
  // reject — otherwise a misconfigured model stops a synced thread being saved
  // and the inbox silently goes stale.
  test('a failed decision model degrades to the rules instead of throwing', async () => {
    const decision = await decideConversation(
      {
        subject: 'Project launch',
        messages: [
          {
            providerMessageId: 'm1',
            internetMessageId: null,
            from: { email: 'sarah@example.com', name: 'Sarah' },
            to: [],
            cc: [],
            subject: 'Project launch',
            snippet: null,
            body: 'Can you confirm Tuesday?',
            bodyHtml: null,
            greeting: null,
            signature: null,
            isFromOwner: false,
            sentAt: new Date('2024-01-15T10:00:00Z'),
          },
        ],
        ownerEmail: OWNER,
        goal: null,
        decidedAt: null,
      },
      {
        rules: new HeuristicRuleClassifier(),
        model: {
          name: 'jev',
          decide: async () => {
            throw new Error('AI service request failed (400)')
          },
        },
        topics: new NoTopicGenerator(),
      },
    )

    // The rules' answer stands, so the thread is still classified and replyable.
    expect(decision.state).toBe('needs-action')
    expect(decision.replyable).toBe(true)
    expect(decision.importance).toBeGreaterThan(0)
    expect(decision.urgency).toBeGreaterThan(0)
  })

  test('a failed topic generator leaves the topic null instead of throwing', async () => {
    const decision = await decideConversation(
      {
        subject: 'Project launch',
        messages: [],
        ownerEmail: OWNER,
        goal: null,
        decidedAt: null,
      },
      {
        rules: new HeuristicRuleClassifier(),
        model: new PlaceholderDecisionModel(),
        topics: {
          name: 'llm:openai',
          generate: async () => {
            throw new Error('AI service request failed (400)')
          },
        },
      },
    )

    expect(decision.topic).toBeNull()
  })
})
describe('html bodies', () => {
  const OWNER_EMAIL = OWNER

  function message(parts: ParsedMessage['parts']): ParsedMessage {
    return {
      subject: 'Newsletter',
      from: 'news@example.com',
      to: [OWNER_EMAIL],
      cc: [],
      date: new Date('2024-01-15T10:00:00Z'),
      messageId: 'm1@example.com',
      parts,
    }
  }

  test('keeps the html part of multipart mail for rich rendering', () => {
    // The bug this guards: HTML was only stored when a message had *no*
    // plain-text part, so almost every real email rendered as bare text.
    const cleaned = cleanMessage(
      message([
        { contentType: 'text/plain', text: 'Read our latest offers.' },
        {
          contentType: 'text/html',
          text: '<table><tr><td><b>Offers</b></td></tr></table>',
        },
      ]),
      OWNER_EMAIL,
    )

    expect(cleaned.bodyHtml).toContain('<b>Offers</b>')
    expect(cleaned.body).toBe('Read our latest offers.')
  })

  test('sanitises the stored html before it is persisted', () => {
    const cleaned = cleanMessage(
      message([
        {
          contentType: 'text/html',
          text: '<p>Safe text</p><script>steal()</script><div onclick="steal()">x</div>',
        },
      ]),
      OWNER_EMAIL,
    )

    expect(cleaned.bodyHtml).not.toContain('script')
    expect(cleaned.bodyHtml).not.toContain('onclick')
    expect(cleaned.bodyHtml).toContain('Safe text')
  })

  test('per-sender choices preserve HTML greeting, signature, and quoted history', () => {
    const cleaned = cleanMessage(
      message([
        {
          contentType: 'text/html',
          text:
            '<div>Hi Sarah,</div><div>See you then.</div>' +
            '<div>Best,</div><div>Sarah</div>' +
            '<div class="gmail_quote">Earlier: old text</div>',
        },
      ]),
      OWNER_EMAIL,
      {
        stripQuotedHistory: false,
        stripGreeting: false,
        stripSignature: false,
      },
    )

    expect(cleaned.body).toContain('Hi Sarah,')
    expect(cleaned.body).toContain('Best,')
    expect(cleaned.body).toContain('Earlier: old text')
    expect(cleaned.strippedGreeting).toBeNull()
    expect(cleaned.strippedSignature).toBeNull()
    expect(cleaned.strippedQuote).toBeNull()
    expect(cleaned.bodyHtml).toContain('Hi Sarah,')
    expect(cleaned.bodyHtml).toContain('Earlier: old text')
  })

  test('strips quoted history out of the html as well as the text', () => {
    const cleaned = cleanMessage(
      message([
        {
          contentType: 'text/html',
          text:
            '<div>My answer</div>' +
            '<div class="gmail_quote">Earlier they wrote: old text</div>',
        },
      ]),
      OWNER_EMAIL,
    )

    expect(cleaned.bodyHtml).toContain('My answer')
    expect(cleaned.bodyHtml).not.toContain('Earlier they wrote')
  })

  test('has no html when the message had none', () => {
    const cleaned = cleanMessage(
      message([{ contentType: 'text/plain', text: 'Just words.' }]),
      OWNER_EMAIL,
    )

    expect(cleaned.bodyHtml).toBeNull()
  })

  test('removes the greeting from the html, not only the text', () => {
    const cleaned = cleanMessage(
      message([
        { contentType: 'text/plain', text: 'Hi Sarah,\n\nSee you then.' },
        {
          contentType: 'text/html',
          text: '<div>Hi Sarah,</div><div>See you then.</div>',
        },
      ]),
      OWNER_EMAIL,
    )

    expect(cleaned.greeting).toBe('Hi Sarah,')
    expect(cleaned.bodyHtml).toContain('See you then.')
    expect(cleaned.bodyHtml).not.toContain('Sarah')
  })

  test('removes the signature from the html, not only the text', () => {
    const cleaned = cleanMessage(
      message([
        {
          contentType: 'text/plain',
          text: 'Agreed.\n\nSent from my iPhone',
        },
        {
          contentType: 'text/html',
          text: '<div>Agreed.</div><div>Sent from my iPhone</div>',
        },
      ]),
      OWNER_EMAIL,
    )

    expect(cleaned.signature).toBe('Sent from my iPhone')
    expect(cleaned.bodyHtml).toContain('Agreed.')
    expect(cleaned.bodyHtml).not.toContain('iPhone')
  })

  test('strips invisible filler out of the plain body', () => {
    const cleaned = cleanMessage(
      message([
        {
          contentType: 'text/plain',
          // Escapes rather than literals: the filler characters themselves trip
          // `no-irregular-whitespace` in source.
          text: 'Real content.\n\u2007\u034f \u2007\u034f\nMore content.',
        },
      ]),
      OWNER_EMAIL,
    )

    expect(cleaned.body).not.toContain('͏')
  })
})

describe('inline image placeholders', () => {
  function message(text: string): ParsedMessage {
    return {
      subject: 'Offerte',
      from: 'guillaume@example.com',
      to: [OWNER],
      cc: [],
      date: new Date('2024-01-15T10:00:00Z'),
      messageId: 'm1@example.com',
      parts: [{ contentType: 'text/plain', text }],
    }
  }

  test('keeps the placeholder out of the signature we store for replies', () => {
    // The signature is offered back when the user replies, so a `[cid:logo]`
    // left here ended up pasted into their own answer as literal text.
    const cleaned = cleanMessage(
      message(
        'Sorry voor het delay.\n\n' +
          'Best regards / Met vriendelijke groeten,\n\n' +
          'Guillaume\n' +
          'CTO @ saply.ai\n' +
          '[cid:logo]',
      ),
      OWNER,
    )

    expect(cleaned.body).toBe('Sorry voor het delay.')
    expect(cleaned.signature).toContain('Guillaume')
    expect(cleaned.signature).not.toContain('[cid:')
  })

  test('keeps a placeholder inside the message out of the rendered body', () => {
    const cleaned = cleanMessage(
      message('Zie [cid:chart] hierboven.\n\nGroeten,\nGuillaume'),
      OWNER,
    )

    expect(cleaned.body).not.toContain('[cid:')
    expect(cleaned.body).toContain('Zie hierboven.')
  })
})

/**
 * Which greeting and signature a reply goes out with.
 *
 * One resolver serves two callers now: the send path, which puts them on the
 * message, and the draft path, which tells the model not to write its own
 * because these are arriving. The precedence is the whole of it.
 */
describe('resolveReplyStyle', () => {
  const lastOwnerMessage = {
    detectedGreeting: 'Dag Sarah,',
    detectedSignature: 'Groet,\nGuillaume',
  }

  test('an enabled sender override wins over everything', () => {
    expect(
      resolveReplyStyle({
        account: { greeting: 'Hoi,', signature: 'Groeten' },
        sender: {
          enabled: true,
          greeting: 'Hello Sarah,',
          signature: 'Best, Guillaume',
        },
        lastOwnerMessage,
      }),
    ).toEqual({ greeting: 'Hello Sarah,', signature: 'Best, Guillaume' })
  })

  test('a disabled sender override falls through to the account defaults', () => {
    expect(
      resolveReplyStyle({
        account: { greeting: 'Hoi,', signature: 'Groeten' },
        sender: { enabled: false, greeting: 'Hello Sarah,', signature: 'Best' },
        lastOwnerMessage,
      }),
    ).toEqual({ greeting: 'Hoi,', signature: 'Groeten' })
  })

  test('with neither set, the user’s own last message in the thread decides', () => {
    expect(
      resolveReplyStyle({
        account: { greeting: null, signature: null },
        sender: null,
        lastOwnerMessage,
      }),
    ).toEqual({ greeting: 'Dag Sarah,', signature: 'Groet,\nGuillaume' })
  })

  test('reports null rather than guessing when there is nothing to go on', () => {
    expect(
      resolveReplyStyle({
        account: { greeting: null, signature: null },
      }),
    ).toEqual({ greeting: null, signature: null })
  })
})
