import { describe, expect, test } from 'bun:test'

import {
  buildConversation,
  cleanMessage,
  conversationId,
  deriveState,
  inferIntent,
  strippedReplyPrefix,
  toParticipant,
} from './model.ts'
import {
  applyDecision,
  NoopDecisionLayer,
  RuleBasedDecisionLayer,
} from './decision.ts'
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
      gmailThreadId: 'thread-1',
    })

    expect(conversation.gmailThreadId).toBe('thread-1')
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
      gmailThreadId: 't',
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
      gmailThreadId: 'profile-thread',
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
      gmailThreadId: 't',
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
      gmailThreadId: 't',
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
      gmailThreadId: 't',
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
      gmailThreadId: 't',
    })

    expect(conversation.topic).toBeNull()
    expect(conversation.goal).toBeNull()
  })

  test('handles an empty thread without throwing', () => {
    const conversation = buildConversation([], {
      ownerEmail: OWNER,
      gmailThreadId: 't',
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
      gmailThreadId: 't',
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

describe('decision layer', () => {
  test('rule-based layer returns a decision without throwing', async () => {
    const layer = new RuleBasedDecisionLayer()
    const decision = await layer.decide({
      subject: 'Project launch',
      messages: [
        {
          gmailMessageId: 'm1',
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

    expect(decision.provider).toBe('rules')
    expect(decision.state).toBe('needs-action')
    expect(decision.reasoning).toBeTruthy()
  })

  test('noop layer returns a neutral decision', async () => {
    const decision = await new NoopDecisionLayer().decide({
      subject: 'x',
      messages: [],
      ownerEmail: OWNER,
      goal: null,
      decidedAt: null,
    })

    expect(decision.provider).toBe('noop')
    expect(decision.state).toBe('informational')
  })

  test('applyDecision never overwrites a user goal', async () => {
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
      gmailThreadId: 't',
    })
    conversation.goal = 'Confirm Tuesday works'

    const updated = applyDecision(conversation, {
      state: 'needs-action',
      importance: 8,
      urgency: 7,
      requiresReply: true,
      intent: 'request',
      currentTopic: 'Launch date',
      reasoning: 'test',
      provider: 'test',
    })

    // The layer's fields apply...
    expect(updated.state).toBe('needs-action')
    expect(updated.topic).toBe('Launch date')
    // ...but the user's goal survives untouched.
    expect(updated.goal).toBe('Confirm Tuesday works')
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
