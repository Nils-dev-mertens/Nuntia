import { describe, expect, test } from 'bun:test'

import { toContactHistoryThread } from '#/lib/contacts/provider-history.ts'
import type { ProviderMessage, ProviderThread } from '#/lib/mailbox/types.ts'

function textPart(text: string) {
  return {
    partId: '1',
    mimeType: 'text/plain',
    filename: null,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    children: [],
    data: Buffer.from(text, 'utf-8').toString('base64'),
  }
}

function message(
  id: string,
  text: string,
  opts: {
    from?: string
    subject?: string
    sentAt?: string
    mimeType?: string
  } = {},
): ProviderMessage {
  const mimeType = opts.mimeType ?? 'text/plain'
  return {
    id,
    threadId: 'thread-1',
    labelIds: [],
    internalDate: String(Date.parse(opts.sentAt ?? '2026-03-01T09:00:00Z')),
    snippet: null,
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      filename: null,
      headers: {
        from: opts.from ?? 'Ana Reyes <ana@example.com>',
        subject: opts.subject ?? 'Invoice for March',
      },
      children: [{ ...textPart(text), mimeType }],
    },
  }
}

function thread(messages: ProviderMessage[]): ProviderThread {
  return { id: 'thread-1', cursor: 'history-1', messages }
}

describe('toContactHistoryThread', () => {
  test('maps a thread to the stored-history shape', () => {
    const history = toContactHistoryThread(
      thread([message('m1', 'Here is the March invoice.')]),
    )

    expect(history).not.toBeNull()
    expect(history?.providerThreadId).toBe('thread-1')
    expect(history?.subject).toBe('Invoice for March')
    expect(history?.messages[0]?.sender).toBe('Ana Reyes')
    expect(history?.messages[0]?.body).toBe('Here is the March invoice.')
    expect(history?.messages[0]?.sentAt).toBe('2026-03-01T09:00:00.000Z')
  })

  test('keeps the newest messages of a long thread', () => {
    const history = toContactHistoryThread(
      thread(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((body, index) =>
          message(`m${index}`, body),
        ),
      ),
    )

    expect(history?.messages.map((entry) => entry.body)).toEqual([
      'c',
      'd',
      'e',
      'f',
    ])
  })

  test('drops messages with no readable body', () => {
    const history = toContactHistoryThread(
      thread([message('m1', '   '), message('m2', 'Actual text.')]),
    )

    expect(history?.messages).toHaveLength(1)
    expect(history?.messages[0]?.body).toBe('Actual text.')
  })

  test('falls back to the HTML part when there is no plain text', () => {
    const history = toContactHistoryThread(
      thread([message('m1', '<p>Hi there</p>', { mimeType: 'text/html' })]),
    )

    expect(history?.messages[0]?.body).toBe('<p>Hi there</p>')
  })

  test('returns null when the thread carries nothing worth prompting', () => {
    expect(toContactHistoryThread(thread([]))).toBeNull()
    expect(toContactHistoryThread(thread([message('m1', '')]))).toBeNull()
  })

  test('truncates a body to the prompt budget', () => {
    const history = toContactHistoryThread(
      thread([message('m1', 'x'.repeat(4_000))]),
    )

    expect(history?.messages[0]?.body).toHaveLength(1_200)
  })
})
