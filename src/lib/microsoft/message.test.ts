import { describe, expect, test } from 'bun:test'

import { toParsedMessage } from '#/lib/mailbox/message.ts'

import { toProviderMessage } from './message.ts'
import type { GraphMessage } from './message.ts'

function graphMessage(overrides: Partial<GraphMessage> = {}): GraphMessage {
  return {
    id: 'AAMk-1',
    conversationId: 'conv-1',
    internetMessageId: '<rfc-1@example.com>',
    subject: 'Re: Launch',
    body: { contentType: 'html', content: '<p>Hello <b>there</b></p>' },
    bodyPreview: 'Hello there',
    from: {
      emailAddress: { name: 'Sarah Chen', address: 'sarah@example.com' },
    },
    toRecipients: [{ emailAddress: { name: 'Me', address: 'me@example.com' } }],
    ccRecipients: [{ emailAddress: { name: null, address: 'cc@example.com' } }],
    receivedDateTime: '2026-01-15T10:00:00Z',
    isDraft: false,
    attachments: [],
    ...overrides,
  }
}

describe('toProviderMessage', () => {
  test('builds the headers the parser reads', () => {
    const parsed = toParsedMessage(toProviderMessage(graphMessage()))

    expect(parsed.subject).toBe('Re: Launch')
    expect(parsed.from).toBe('sarah@example.com')
    expect(parsed.fromName).toBe('Sarah Chen')
    expect(parsed.to).toEqual(['Me <me@example.com>'])
    expect(parsed.cc).toEqual(['cc@example.com'])
    expect(parsed.messageId).toBe('rfc-1@example.com')
    expect(parsed.date?.toISOString()).toBe('2026-01-15T10:00:00.000Z')
  })

  test('keeps the HTML body and decodes it as text/html', () => {
    const message = toProviderMessage(graphMessage())
    const parsed = toParsedMessage(message)

    expect(parsed.parts).toHaveLength(1)
    expect(parsed.parts[0].contentType).toBe('text/html')
    expect(parsed.parts[0].text).toContain('<b>there</b>')
  })

  test('treats a text body as text/plain', () => {
    const parsed = toParsedMessage(
      toProviderMessage(
        graphMessage({ body: { contentType: 'text', content: 'plain words' } }),
      ),
    )

    expect(parsed.parts[0].contentType).toBe('text/plain')
    expect(parsed.parts[0].text).toBe('plain words')
  })

  test('a draft is labelled the way the sync filter expects', () => {
    expect(toProviderMessage(graphMessage({ isDraft: true })).labelIds).toEqual(
      ['DRAFT'],
    )
    expect(toProviderMessage(graphMessage()).labelIds).toEqual([])
  })

  test('attachment metadata becomes a leaf the download path can find', () => {
    const message = toProviderMessage(
      graphMessage({
        attachments: [
          {
            id: 'att-1',
            name: 'contract.pdf',
            contentType: 'application/pdf',
            size: 2048,
            isInline: false,
            contentId: null,
          },
        ],
      }),
    )

    const leaf = message.payload?.children.at(-1)
    expect(leaf?.mimeType).toBe('application/pdf')
    expect(leaf?.filename).toBe('contract.pdf')
    expect(leaf?.headers['x-attachment-id']).toBe('att-1')
    expect(leaf?.headers['x-attachment-size']).toBe('2048')
    expect(leaf?.headers['content-disposition']).toBe('attachment')
  })

  test('an inline image carries its Content-ID without brackets', () => {
    const message = toProviderMessage(
      graphMessage({
        attachments: [
          {
            id: 'att-2',
            name: 'logo.png',
            contentType: 'image/png',
            size: 10,
            isInline: true,
            contentId: 'logo@example.com',
          },
        ],
      }),
    )

    const leaf = message.payload?.children.at(-1)
    expect(leaf?.headers['content-disposition']).toBe('inline')
    expect(leaf?.headers['content-id']).toBe('<logo@example.com>')
  })

  test('falls back to the Graph id when Microsoft gives no RFC Message-ID', () => {
    const parsed = toParsedMessage(
      toProviderMessage(graphMessage({ internetMessageId: null })),
    )

    expect(parsed.messageId).toBe('AAMk-1')
  })
})
