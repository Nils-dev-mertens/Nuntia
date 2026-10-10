import { describe, expect, test } from 'bun:test'

import type {
  Conversation,
  ConversationMessage,
} from '#/lib/conversation/index.ts'

import { FakeGmailClient } from './fake.ts'
import { ReplyNotPossibleError, sendReply } from './send.ts'

const OWNER = 'me@example.com'

function message(overrides: Partial<ConversationMessage>): ConversationMessage {
  return {
    gmailMessageId: 'g1',
    internetMessageId: null,
    from: { email: 'alice@example.com', name: 'Alice' },
    to: [{ email: OWNER, name: null }],
    cc: [],
    subject: 'Project launch',
    snippet: null,
    body: 'Can you confirm Tuesday?',
    bodyHtml: null,
    greeting: null,
    signature: null,
    isFromOwner: false,
    sentAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  }
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  const messages = overrides.messages ?? [message({})]

  return {
    id: 'me@example.com:thread-1',
    gmailThreadId: 'thread-1',
    subject: 'Project launch',
    participants: [
      { email: OWNER, name: null },
      { email: 'alice@example.com', name: 'Alice' },
    ],
    messages,
    attachments: [],
    state: 'needs-action',
    isAutomated: false,
    replyable: true,
    awaitingReply: true,
    requiresReply: true,
    importance: 5,
    urgency: 5,
    intent: 'request',
    messageCount: messages.length,
    attachmentCount: 0,
    lastMessageAt: messages.at(-1)?.sentAt ?? new Date(0),
    topic: null,
    goal: null,
    ...overrides,
  }
}

/**
 * The message body, everything after the header block.
 *
 * Not `split('\r\n\r\n')[1]`: quoted-printable turns the blank line inside a
 * body into `\r\n\r\n` too, so splitting on the first occurrence silently
 * truncates the reply.
 */
function bodyOf(raw: string): string {
  const separator = raw.indexOf('\r\n\r\n')
  return separator === -1 ? '' : raw.slice(separator + 4)
}

function headersOf(raw: string): string {
  return raw.split('\r\n\r\n')[0] ?? ''
}

describe('sendReply', () => {
  test('sends into the existing thread', async () => {
    const client = new FakeGmailClient()
    await sendReply(client, OWNER, conversation(), 'Yes, Tuesday works.')

    expect(client.sent).toHaveLength(1)
    expect(client.sent[0]?.threadId).toBe('thread-1')
  })

  test('uses sender-specific reply greeting and signature overrides', async () => {
    const client = new FakeGmailClient()
    const conv = conversation({
      messages: [
        message({
          replyGreeting: null,
          replySignature: null,
        }),
      ],
    })
    await sendReply(client, OWNER, conv, 'Thanks!', {
      replyStyle: { greeting: 'Hello Alice,', signature: 'Cheers,\nMe' },
    })
    expect(bodyOf(client.sent[0]?.raw ?? '')).toContain('Hello Alice,')
    expect(bodyOf(client.sent[0]?.raw ?? '')).toContain('Cheers,')
  })

  test('an explicit empty sender style suppresses guessed defaults', async () => {
    const client = new FakeGmailClient()
    const conv = conversation({
      messages: [
        message({
          replyGreeting: 'Hello Alice,',
          replySignature: 'Best,\\nMe',
        }),
      ],
    })
    await sendReply(client, OWNER, conv, 'Thanks!', {
      replyStyle: { greeting: null, signature: null },
    })
    const sentBody = bodyOf(client.sent[0]?.raw ?? '')
    expect(sentBody).not.toContain('Hello Alice,')
    expect(sentBody).not.toContain('Best,')
    expect(sentBody).toContain('Thanks!')
  })

  test('addresses everyone except the owner', async () => {
    const client = new FakeGmailClient()
    const conv = conversation({
      participants: [
        { email: OWNER, name: null },
        { email: 'alice@example.com', name: 'Alice' },
        { email: 'bob@example.com', name: 'Bob' },
        { email: 'carol@example.com', name: 'Carol' },
      ],
    })

    await sendReply(client, OWNER, conv, 'Thanks!')

    const headers = headersOf(client.sent[0]?.raw ?? '')
    expect(headers).toContain(
      'To: alice@example.com, bob@example.com, carol@example.com',
    )
    expect(headers).not.toContain('me@example.com')
  })

  test('keeps everyone on the thread even if the last message is your own', async () => {
    // Reading only the newest message's To: header would drop Alice here,
    // because a reply-to-one carries just that one address.
    const client = new FakeGmailClient()
    const conv = conversation({
      participants: [
        { email: OWNER, name: null },
        { email: 'alice@example.com', name: 'Alice' },
      ],
      messages: [
        message({ internetMessageId: '<a@mail.example.com>' }),
        message({
          from: { email: OWNER, name: null },
          to: [{ email: OWNER, name: null }],
          cc: [],
          isFromOwner: true,
          internetMessageId: '<b@mail.example.com>',
          sentAt: new Date('2026-10-01T11:00:00Z'),
        }),
      ],
    })

    await sendReply(client, OWNER, conv, 'Still good.')

    expect(headersOf(client.sent[0]?.raw ?? '')).toContain(
      'To: alice@example.com',
    )
  })

  test('does not double up the Re: prefix', async () => {
    const client = new FakeGmailClient()

    await sendReply(client, OWNER, conversation(), 'Hi')
    expect(headersOf(client.sent[0]?.raw ?? '')).toContain(
      'Subject: Re: Project launch',
    )

    await sendReply(
      client,
      OWNER,
      conversation({ subject: 'Re: Project launch' }),
      'Hi',
    )
    expect(headersOf(client.sent[1]?.raw ?? '')).toContain(
      'Subject: Re: Project launch',
    )
    expect(headersOf(client.sent[1]?.raw ?? '')).not.toContain('Re: Re:')
  })

  test('restores the greeting and signature the user actually uses', async () => {
    const client = new FakeGmailClient()
    const conv = conversation({
      messages: [
        message({ internetMessageId: '<a@mail.example.com>' }),
        message({
          from: { email: OWNER, name: null },
          isFromOwner: true,
          body: 'Tuesday works for me.',
          greeting: 'Hi Alice,',
          signature: 'Best,\nNils',
          sentAt: new Date('2026-10-01T11:00:00Z'),
        }),
      ],
    })

    await sendReply(client, OWNER, conv, 'Sounds good.')

    const body = bodyOf(client.sent[0]?.raw ?? '')
    // Without this the recipient gets a reply that opens mid-thought.
    expect(body).toContain('Hi Alice,')
    expect(body).toContain('Sounds good.')
    // The signature belongs to the reply, so it sits above the quoted history —
    // below it, the signature read as part of the message being quoted.
    expect(body).toContain('Best,')
    expect(body.indexOf('Best,')).toBeLessThan(body.indexOf('wrote:'))
    expect(body.indexOf('Sounds good.')).toBeLessThan(body.indexOf('Best,'))
  })

  test('omits the greeting when the user has never written in the thread', async () => {
    const client = new FakeGmailClient()
    await sendReply(client, OWNER, conversation(), 'Just this.')

    const body = bodyOf(client.sent[0]?.raw ?? '')
    expect(body).toContain('Just this.')
    expect(body.startsWith('Just this.')).toBe(true)
  })

  test('sets In-Reply-To and References so other clients thread it', async () => {
    const client = new FakeGmailClient()
    const conv = conversation({
      messages: [
        message({ internetMessageId: '<first@mail.example.com>' }),
        message({
          internetMessageId: '<second@mail.example.com>',
          sentAt: new Date('2026-10-01T12:00:00Z'),
        }),
      ],
    })

    await sendReply(client, OWNER, conv, 'Confirming.')

    const headers = headersOf(client.sent[0]?.raw ?? '')
    expect(headers).toContain('In-Reply-To: <second@mail.example.com>')
    expect(headers).toContain(
      'References: <first@mail.example.com> <second@mail.example.com>',
    )
  })

  test('quotes the thread so the recipient has the context', async () => {
    const client = new FakeGmailClient()
    await sendReply(client, OWNER, conversation(), 'Confirmed.')

    const body = bodyOf(client.sent[0]?.raw ?? '')
    expect(body).toContain('wrote:')
    expect(body).toContain('> Can you confirm Tuesday?')
  })

  test('can be told not to quote', async () => {
    const client = new FakeGmailClient()
    await sendReply(client, OWNER, conversation(), 'Confirmed.', {
      quoteOriginal: false,
    })

    expect(bodyOf(client.sent[0]?.raw ?? '')).not.toContain('wrote:')
  })

  test('sends uploaded files as MIME attachments', async () => {
    const client = new FakeGmailClient()
    const bytes = Uint8Array.from([0, 255, 1, 128])
    const data = Buffer.from(bytes).toString('base64')

    await sendReply(client, OWNER, conversation(), 'See attached.', {
      attachments: [
        {
          filename: 'quarterly.pdf',
          contentType: 'application/pdf',
          data,
        },
      ],
    })

    const raw = client.sent[0]?.raw ?? ''
    expect(raw).toContain('multipart/mixed;')
    expect(raw).toContain('filename="quarterly.pdf"')
    expect(raw).toContain('AP8BgA==')
    expect(client.sent[0]?.threadId).toBe('thread-1')
  })

  test('allows an attachment-only reply', async () => {
    const client = new FakeGmailClient()
    await sendReply(client, OWNER, conversation(), '', {
      attachments: [
        {
          filename: 'note.txt',
          contentType: 'text/plain',
          data: Buffer.from('hello').toString('base64'),
        },
      ],
    })

    expect(client.sent).toHaveLength(1)
    expect(client.sent[0]?.raw).toContain('aGVsbG8=')
  })

  test('rejects malformed and oversized attachment uploads before sending', async () => {
    const client = new FakeGmailClient()

    await expect(
      sendReply(client, OWNER, conversation(), 'See attached.', {
        attachments: [
          { filename: 'x.bin', contentType: 'x/test', data: 'not base64' },
        ],
      }),
    ).rejects.toThrow(/could not be read/i)
    expect(client.sent).toHaveLength(0)
  })

  test('refuses an empty reply', async () => {
    const client = new FakeGmailClient()
    await expect(
      sendReply(client, OWNER, conversation(), '   \n  '),
    ).rejects.toThrow(ReplyNotPossibleError)
    expect(client.sent).toHaveLength(0)
  })

  test('refuses to reply to an automated thread', async () => {
    // The whole point of the automated classification: no reply box, and the
    // server refuses too, so a stale UI cannot send into a void.
    const client = new FakeGmailClient()
    const conv = conversation({ isAutomated: true, replyable: false })

    await expect(sendReply(client, OWNER, conv, 'Thanks!')).rejects.toThrow(
      /no reply address/i,
    )
    expect(client.sent).toHaveLength(0)
  })

  test('refuses when the conversation has no reply address', async () => {
    // A human thread the decision layer judged unanswerable — a broadcast with
    // no return address. The composer is hidden, and the server refuses too.
    const client = new FakeGmailClient()
    const conv = conversation({ replyable: false })

    await expect(sendReply(client, OWNER, conv, 'Hello?')).rejects.toThrow(
      /no address to reply to/i,
    )
    expect(client.sent).toHaveLength(0)
  })

  test('refuses when no recipient can be found', async () => {
    const client = new FakeGmailClient()
    const conv = conversation({
      participants: [{ email: OWNER, name: null }],
    })

    await expect(sendReply(client, OWNER, conv, 'Hello?')).rejects.toThrow(
      /recipient/i,
    )
    expect(client.sent).toHaveLength(0)
  })
})
