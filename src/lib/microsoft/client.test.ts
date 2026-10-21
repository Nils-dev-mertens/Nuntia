import { describe, expect, test } from 'bun:test'

import {
  createGraphClient,
  GRAPH_MAX_ATTACHMENT_BYTES,
  MicrosoftAuthError,
} from './client.ts'

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

type Call = { url: string; method: string; body: unknown }

/**
 * A fake Graph that answers by URL fragment.
 *
 * Keeping the routing in the test rather than a mock library means the
 * assertions read as the actual request sequence a send makes.
 */
function fakeFetch(handler: (url: string, init: RequestInit) => Response): {
  fetchImpl: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []

  const fetchImpl = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = String(input)
    const body =
      typeof init.body === 'string' && init.body.length > 0
        ? (JSON.parse(init.body) as unknown)
        : null
    calls.push({ url, method: init.method ?? 'GET', body })
    return handler(url, init)
  }) as typeof fetch

  return { fetchImpl, calls }
}

function client(
  fetchImpl: typeof fetch,
  sleepImpl: (ms: number) => Promise<void> = async () => {},
) {
  return createGraphClient({
    getAccessToken: async () => 'graph-token',
    email: 'me@example.com',
    fetchImpl,
    sleepImpl,
  })
}

describe('Graph listThreads', () => {
  test('deduplicates messages into conversations and follows the next link', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url.includes('skiptoken=2')) {
        return json(200, {
          value: [
            { id: 'm3', conversationId: 'conv-1' },
            { id: 'm4', conversationId: 'conv-3' },
          ],
        })
      }
      return json(200, {
        value: [
          { id: 'm1', conversationId: 'conv-1' },
          { id: 'm2', conversationId: 'conv-1' },
          { id: 'm3', conversationId: 'conv-2' },
        ],
        '@odata.nextLink':
          'https://graph.microsoft.com/v1.0/me/messages?skiptoken=2',
      })
    })

    const page = await client(fetchImpl).listThreads({})

    expect(page.threads.map((t) => t.id)).toEqual(['conv-1', 'conv-2'])
    expect(page.nextPageToken).toContain('skiptoken=2')

    const next = await client(fetchImpl).listThreads({
      pageToken: page.nextPageToken ?? undefined,
    })
    expect(next.threads.map((t) => t.id)).toEqual(['conv-1', 'conv-3'])

    // The first request carries the 30-day window and asks only for the ids the
    // listing needs.
    expect(calls[0].url).toContain('receivedDateTime+ge')
    expect(calls[0].url).toContain('%24select=id%2CconversationId')
  })
})

describe('Graph getThread', () => {
  test('asks for one conversation and converts every message', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(200, {
        value: [
          {
            id: 'm1',
            conversationId: 'conv-1',
            internetMessageId: '<one@example.com>',
            subject: 'Launch',
            body: { contentType: 'text', content: 'First' },
            from: { emailAddress: { address: 'sarah@example.com' } },
            toRecipients: [],
            receivedDateTime: '2026-01-15T09:00:00Z',
            isDraft: false,
            attachments: [],
          },
          {
            id: 'm2',
            conversationId: 'conv-1',
            internetMessageId: '<two@example.com>',
            subject: 'Re: Launch',
            body: { contentType: 'text', content: 'Second' },
            from: { emailAddress: { address: 'me@example.com' } },
            toRecipients: [],
            receivedDateTime: '2026-01-15T10:00:00Z',
            isDraft: false,
            attachments: [],
          },
        ],
      }),
    )

    const thread = await client(fetchImpl).getThread('conv-1')

    expect(thread.id).toBe('conv-1')
    expect(thread.messages).toHaveLength(2)
    expect(thread.messages[1].id).toBe('m2')
    expect(calls[0].url).toContain('conversationId+eq+%27conv-1%27')
  })
})

describe('Graph incremental cursor', () => {
  test('lists messages received since the stored timestamp', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(200, {
        value: [
          { id: 'm9', conversationId: 'conv-9' },
          { id: 'm8', conversationId: null },
        ],
      }),
    )

    const page = await client(fetchImpl).listHistory({
      startHistoryId: '2026-01-01T00:00:00.000Z',
    })

    expect(page.history[0].messages).toEqual([{ id: 'm9', threadId: 'conv-9' }])
    expect(page.cursor).toBeTruthy()
    expect(calls[0].url).toContain('receivedDateTime+ge+2026-01-01')
  })

  test('a non-timestamp cursor is refused instead of guessed at', async () => {
    const { fetchImpl } = fakeFetch(() => json(200, { value: [] }))

    await expect(
      client(fetchImpl).listHistory({ startHistoryId: '12345' }),
    ).rejects.toThrow(/cursor is not a timestamp/i)
  })
})

describe('Graph attachments', () => {
  test('returns the base64 bytes Graph sent', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(200, { contentBytes: 'aGVsbG8=', size: 5 }),
    )

    const payload = await client(fetchImpl).getAttachment('m1', 'att-1')

    expect(payload).toEqual({ data: 'aGVsbG8=', size: 5 })
  })
})

describe('Graph sendReply', () => {
  function sendRoutes() {
    return (url: string, init: RequestInit) => {
      if (url.includes('/me/messages?') && url.includes('conversationId')) {
        return json(200, {
          value: [
            { id: 'm2', internetMessageId: '<two@example.com>' },
            { id: 'm1', internetMessageId: '<one@example.com>' },
          ],
        })
      }
      if (url.endsWith('/createReply')) {
        return json(201, { id: 'draft-1' })
      }
      if (url.endsWith('/draft-1/attachments')) {
        return json(201, { id: 'att-new' })
      }
      if (url.endsWith('/draft-1/send')) {
        return new Response(null, { status: 202 })
      }
      if (url.endsWith('/draft-1')) {
        expect(init.method).toBe('PATCH')
        return json(200, { id: 'draft-1' })
      }
      throw new Error(`unexpected request: ${url}`)
    }
  }

  test('threads onto the matching message, replaces the body, then sends', async () => {
    const { fetchImpl, calls } = fakeFetch((url, init) =>
      sendRoutes()(url, init),
    )

    const result = await client(fetchImpl).sendReply?.({
      threadId: 'conv-1',
      inReplyTo: '<one@example.com>',
      references: ['<one@example.com>'],
      subject: 'Re: Launch',
      to: ['sarah@example.com'],
      cc: [],
      text: 'Thanks',
      html: '<p>Thanks</p>',
      attachments: [],
    })

    expect(result).toEqual({ id: 'draft-1', threadId: 'conv-1', labelIds: [] })

    const patch = calls.find((call) => call.method === 'PATCH')
    expect(patch?.url).toContain('/me/messages/draft-1')
    expect(patch?.body).toMatchObject({
      subject: 'Re: Launch',
      body: { contentType: 'HTML', content: '<p>Thanks</p>' },
      toRecipients: [{ emailAddress: { address: 'sarah@example.com' } }],
    })

    // The reply targets the message whose RFC id matched, not simply the newest.
    expect(calls.some((call) => call.url.endsWith('/m1/createReply'))).toBe(
      true,
    )
    expect(calls.at(-1)?.url).toContain('/draft-1/send')
  })

  test('uploads each attachment as a fileAttachment before sending', async () => {
    const { fetchImpl, calls } = fakeFetch((url, init) =>
      sendRoutes()(url, init),
    )

    await client(fetchImpl).sendReply?.({
      threadId: 'conv-1',
      inReplyTo: null,
      references: [],
      subject: 'Re: Launch',
      to: ['sarah@example.com'],
      cc: [],
      text: 'See attached',
      html: '<p>See attached</p>',
      attachments: [
        {
          filename: 'note.txt',
          contentType: 'text/plain',
          data: new TextEncoder().encode('hello'),
        },
      ],
    })

    const upload = calls.find((call) =>
      call.url.endsWith('/draft-1/attachments'),
    )
    expect(upload?.body).toMatchObject({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'note.txt',
      contentType: 'text/plain',
      contentBytes: 'aGVsbG8=',
    })

    // Attachment before send, or Graph sends a message without it.
    expect(calls.findIndex((c) => c.url.endsWith('/send'))).toBeGreaterThan(
      calls.findIndex((c) => c.url.endsWith('/attachments')),
    )
  })

  test('refuses a file over the simple-attachment limit before uploading', async () => {
    const { fetchImpl, calls } = fakeFetch((url, init) =>
      sendRoutes()(url, init),
    )

    const oversized = new Uint8Array(GRAPH_MAX_ATTACHMENT_BYTES + 1)

    await expect(
      client(fetchImpl).sendReply?.({
        threadId: 'conv-1',
        inReplyTo: null,
        references: [],
        subject: 'Re: Launch',
        to: ['sarah@example.com'],
        cc: [],
        text: '',
        html: '<p></p>',
        attachments: [
          {
            filename: 'big.bin',
            contentType: 'application/octet-stream',
            data: oversized,
          },
        ],
      }),
    ).rejects.toThrow(/3 MB/)
    expect(calls.some((c) => c.url.endsWith('/attachments'))).toBe(false)
  })
})

describe('Graph error handling', () => {
  test('a 401 is an auth failure the UI can offer a reconnect for', async () => {
    const { fetchImpl } = fakeFetch(() => json(401, { error: 'expired' }))

    await expect(client(fetchImpl).getThread('conv-1')).rejects.toBeInstanceOf(
      MicrosoftAuthError,
    )
  })

  test('a 429 is retried after the given delay', async () => {
    let attempts = 0
    const waits: number[] = []
    const { fetchImpl } = fakeFetch(() => {
      attempts++
      if (attempts === 1) {
        return json(429, {}, { 'retry-after': '2' })
      }
      return json(200, { value: [] })
    })

    await client(fetchImpl, async (ms) => {
      waits.push(ms)
    }).getThread('conv-1')

    expect(attempts).toBe(2)
    expect(waits).toEqual([2000])
  })
})
