import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Sync writes to the database, so each run needs its own SQLite file.
 *
 * `test/setup.ts` (preloaded via bunfig.toml) already points `DATABASE_URL` at a
 * temp file before any module loads — this local override is now redundant, and
 * is kept only so this file still gets a freshly migrated database of its own.
 *
 * It is no longer load-bearing. It used to be, and that was a trap: isolation
 * depended on this file being the first to import `#/db/index.ts`, so adding any
 * test file with a static import of the conversation layer silently redirected
 * the entire suite at the real mailbox.
 */
const tmpDir = mkdtempSync(join(tmpdir(), 'lumen-sync-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const { accounts, appSettings, conversations, decisions, messages } =
  await import('#/db/schema.ts')
const { FakeGmailClient } = await import('./fake.ts')
const { backfill, syncIncremental, sync } = await import('./sync.ts')
const { toParsedMessage, toAttachmentRefs } = await import('./message.ts')
const { decodeGmailData } = await import('./message.ts')
const { safeFilename, MAX_ATTACHMENT_BYTES } = await import('./attachments.ts')
const {
  getConversation,
  getParsingProfileContext,
  listConversations,
  saveConversation,
  saveParsingProfile,
  setConversationDetails,
} = await import('#/lib/conversation/index.ts')

const { migrate } = await import('drizzle-orm/libsql/migrator')
await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const ACCOUNT = 'me@example.com'

afterAll(async () => {
  // best-effort cleanup; the temp dir is disposable either way
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(decisions)
  await db.delete(messages)
  await db.delete(conversations)
  await db.delete(appSettings)
  await db.delete(accounts)

  await db.insert(accounts).values({
    id: ACCOUNT,
    email: ACCOUNT,
    refreshTokenEncrypted: 'v1:a:b:c',
  })
})

/** base64url without padding, matching Gmail's encoding. */
function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Normalize a raw Gmail payload into the `GmailPart` shape the client adapter
 * produces: headers flattened to a record, children as `children`, and the
 * attachmentId carried on headers.
 *
 * Fixtures are written in raw Gmail form on purpose — it documents the wire
 * format, and this mirrors what `toGmailPart` does in production.
 */
function normalizePart(raw: any): any {
  const headers: Record<string, string> = {}
  for (const h of raw.headers ?? []) {
    if (h?.name) headers[String(h.name).toLowerCase()] = h.value ?? ''
  }

  if (raw.body?.attachmentId) {
    headers['x-attachment-id'] = raw.body.attachmentId
  }
  if (raw.body?.size != null) {
    headers['x-attachment-size'] = String(raw.body.size)
  }

  return {
    partId: raw.partId ?? '',
    mimeType: raw.mimeType ?? 'application/octet-stream',
    filename: raw.filename ?? null,
    data: raw.body?.data ?? undefined,
    headers,
    children: (raw.parts ?? []).map(normalizePart),
  }
}

/** Build a text/plain Gmail payload. */
function textPayload(args: {
  headers: Record<string, string>
  body: string
  partId?: string
}): any {
  return {
    partId: args.partId ?? '',
    mimeType: 'text/plain',
    filename: null,
    body: { data: toBase64Url(args.body) },
    headers: Object.entries(args.headers).map(([name, value]) => ({
      name,
      value,
    })),
  }
}

/** Build a multipart payload with an attachment part. */
function multipartPayload(args: {
  headers: Record<string, string>
  text: string
  attachment: {
    filename: string
    mimeType: string
    attachmentId: string
    size: number
    inline?: boolean
  }
}): any {
  return {
    partId: '',
    mimeType: 'multipart/mixed',
    filename: null,
    headers: Object.entries(args.headers).map(([name, value]) => ({
      name,
      value,
    })),
    parts: [
      textPayload({ headers: {}, body: args.text, partId: '0' }),
      {
        partId: '1',
        mimeType: args.attachment.mimeType,
        filename: args.attachment.filename,
        headers: [
          {
            name: 'content-disposition',
            value: args.attachment.inline
              ? `inline; filename="${args.attachment.filename}"`
              : `attachment; filename="${args.attachment.filename}"`,
          },
          { name: 'x-attachment-id', value: args.attachment.attachmentId },
          { name: 'x-attachment-size', value: String(args.attachment.size) },
          ...(args.attachment.inline
            ? [{ name: 'content-id', value: '<logo123>' }]
            : []),
        ],
        // Attachment parts carry no inline data — fetched separately.
        body: {},
      },
    ],
  }
}

function message(args: {
  id: string
  threadId: string
  from: string
  to?: string
  subject: string
  date: string
  body: string
  labels?: string[]
}): any {
  return {
    id: args.id,
    threadId: args.threadId,
    labelIds: args.labels ?? ['INBOX'],
    internalDate: String(new Date(args.date).getTime()),
    snippet: args.body.slice(0, 40),
    payload: normalizePart(
      textPayload({
        headers: {
          from: args.from,
          to: args.to ?? ACCOUNT,
          subject: args.subject,
          date: args.date,
        },
        body: args.body,
      }),
    ),
  }
}

describe('toParsedMessage', () => {
  test('extracts headers into a ParsedMessage', () => {
    const parsed = toParsedMessage(
      message({
        id: 'm1',
        threadId: 't1',
        from: 'Sarah <sarah@example.com>',
        subject: 'Re: Project launch',
        date: 'Mon, 15 Jan 2024 10:00:00 +0100',
        body: 'Tuesday works for me.',
      }),
    )

    expect(parsed.subject).toBe('Re: Project launch')
    expect(parsed.from).toBe('sarah@example.com')
    expect(parsed.to).toEqual([ACCOUNT])
    expect(parsed.messageId).toBe('m1')
    expect(parsed.date).toBeInstanceOf(Date)
  })

  test('decodes base64url body data', () => {
    const parsed = toParsedMessage(
      message({
        id: 'm1',
        threadId: 't1',
        from: 's@e.com',
        subject: 'Unicode',
        date: 'Mon, 15 Jan 2024 10:00:00 +0000',
        body: 'Grüße — café',
      }),
    )

    expect(parsed.parts[0].text).toBe('Grüße — café')
  })

  test('decodes base64url without padding', () => {
    // A 1-byte payload encodes to "AA" with no padding; the decoder must cope.
    expect(decodeGmailData('AA').toString('utf8')).toBe('\u0000')
    // Full alphabet coverage including - and _.
    const bytes = Buffer.from([251, 255, 190, 255])
    const b64url = bytes
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(decodeGmailData(b64url).equals(bytes)).toBe(true)
  })

  test('prefers internalDate over a missing Date header', () => {
    const msg = message({
      id: 'm1',
      threadId: 't1',
      from: 's@e.com',
      subject: 'X',
      date: 'Mon, 15 Jan 2024 10:00:00 +0000',
      body: 'Hi',
    })
    delete msg.payload.headers

    const parsed = toParsedMessage(msg)
    expect(parsed.date?.toISOString()).toContain('2024-01-15')
  })

  test('falls back to html when there is no plain text part', () => {
    const htmlOnly = {
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX'],
      internalDate: String(Date.now()),
      snippet: '',
      payload: normalizePart({
        partId: '',
        mimeType: 'text/html',
        filename: null,
        headers: [
          { name: 'from', value: 's@e.com' },
          { name: 'subject', value: 'Hi' },
        ],
        body: { data: toBase64Url('<p>Hello</p>') },
      }),
    }

    const parsed = toParsedMessage(htmlOnly)
    expect(parsed.parts.some((p) => p.contentType === 'text/html')).toBe(true)
    expect(parsed.parts.some((p) => p.contentType === 'text/plain')).toBe(false)
  })

  test('returns an empty part list for a message with no payload', () => {
    const parsed = toParsedMessage({
      id: 'm1',
      threadId: 't1',
      labelIds: [],
      internalDate: null,
      snippet: null,
      payload: null,
    })
    expect(parsed.parts).toEqual([])
  })
})

describe('toAttachmentRefs', () => {
  test('collects attachment metadata from the MIME tree', () => {
    const msg = {
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX'],
      internalDate: String(Date.now()),
      snippet: '',
      payload: normalizePart(
        multipartPayload({
          headers: { from: 's@e.com', subject: 'Report' },
          text: 'See attached.',
          attachment: {
            filename: 'q1.pdf',
            mimeType: 'application/pdf',
            attachmentId: 'att-1',
            size: 2048,
          },
        }),
      ),
    }

    const refs = toAttachmentRefs(msg)
    expect(refs).toHaveLength(1)
    expect(refs[0].filename).toBe('q1.pdf')
    expect(refs[0].mimeType).toBe('application/pdf')
    expect(refs[0].sizeBytes).toBe(2048)
    expect(refs[0].isInline).toBe(false)
  })

  test('marks inline images and strips angle brackets from content-id', () => {
    const msg = {
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX'],
      internalDate: String(Date.now()),
      snippet: '',
      payload: normalizePart(
        multipartPayload({
          headers: { from: 's@e.com', subject: 'With logo' },
          text: 'Hello',
          attachment: {
            filename: 'logo.png',
            mimeType: 'image/png',
            attachmentId: 'att-2',
            size: 100,
            inline: true,
          },
        }),
      ),
    }

    const refs = toAttachmentRefs(msg)
    expect(refs[0].isInline).toBe(true)
    expect(refs[0].contentId).toBe('logo123')
  })
})

describe('sender parsing profiles', () => {
  test('stores sender parsing and reply-style preferences', async () => {
    await saveParsingProfile(
      ACCOUNT,
      'Alice@Example.com',
      {
        greeting: 'Hello,',
        signature: 'Best,\nMe',
        parsing: {
          stripQuotedHistory: false,
          stripGreeting: false,
          stripSignature: true,
        },
      },
      {
        useAccountParsingDefaults: false,
        stripQuotedHistory: true,
        stripGreeting: true,
        stripSignature: false,
        replyStyleEnabled: true,
        replyGreeting: 'Hi Alice,',
        replySignature: 'Cheers,\nMe',
      },
    )

    const profiles = await getParsingProfileContext(ACCOUNT)
    expect(profiles.parsingDefaults).toEqual({
      stripQuotedHistory: false,
      stripGreeting: false,
      stripSignature: true,
    })
    expect(profiles.parsingPreferences['alice@example.com']).toEqual({
      stripQuotedHistory: true,
      stripGreeting: true,
      stripSignature: false,
    })
    expect(profiles.parsingProfiles['alice@example.com']).toMatchObject({
      useAccountParsingDefaults: false,
      stripQuotedHistory: true,
      stripGreeting: true,
      stripSignature: false,
    })
    expect(profiles.replyStyles.account.greeting).toBe('Hello,')
    expect(profiles.replyStyles.senders['alice@example.com']).toEqual({
      enabled: true,
      greeting: 'Hi Alice,',
      signature: 'Cheers,\nMe',
    })
  })

  test('sync applies saved sender overrides and retains removed text for inspection', async () => {
    await saveParsingProfile(
      ACCOUNT,
      'alice@example.com',
      {
        greeting: null,
        signature: null,
        parsing: {
          stripQuotedHistory: true,
          stripGreeting: true,
          stripSignature: true,
        },
      },
      {
        useAccountParsingDefaults: false,
        stripQuotedHistory: false,
        stripGreeting: false,
        stripSignature: true,
        replyStyleEnabled: false,
        replyGreeting: null,
        replySignature: null,
      },
    )
    const client = new FakeGmailClient({
      threads: [
        {
          id: 'sender-profile-thread',
          historyId: '901',
          messages: [
            message({
              id: 'sender-profile-message',
              threadId: 'sender-profile-thread',
              from: 'Alice <alice@example.com>',
              subject: 'Project',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'Hi Alex,\n\nA reply.\n\nBest,\nAlice\n\nOn Monday Alex wrote:\n> Original.',
            }),
          ],
        },
      ],
    })

    await backfill(client, ACCOUNT)
    const saved = (await listConversations(ACCOUNT)).find(
      (item) => item.gmailThreadId === 'sender-profile-thread',
    )
    expect(saved?.messages[0].body).toContain('Hi Alex,')
    expect(saved?.messages[0].body).toContain('On Monday Alex wrote:')
    expect(saved?.messages[0].strippedGreeting).toBeNull()
    expect(saved?.messages[0].strippedSignature ?? '').toContain('Best,')
    expect(saved?.messages[0].strippedQuote).toBeNull()

    const { loadConversation } = await import('./service.ts')
    const detail = await loadConversation('sender-profile-thread')
    expect(detail?.parsingProfile).toMatchObject({
      senderEmail: 'alice@example.com',
      useAccountParsingDefaults: false,
      stripQuotedHistory: false,
      stripGreeting: false,
      stripSignature: true,
    })
    expect(detail?.messages[0].strippedSignature ?? '').toContain('Best,')
  })

  test('reuses account-wide parsing defaults when a sender inherits them', async () => {
    const { buildConversation } = await import('#/lib/conversation/index.ts')
    await saveParsingProfile(
      ACCOUNT,
      'alice@example.com',
      {
        greeting: null,
        signature: null,
        parsing: {
          stripQuotedHistory: false,
          stripGreeting: false,
          stripSignature: false,
        },
      },
      {
        useAccountParsingDefaults: true,
        stripQuotedHistory: true,
        stripGreeting: true,
        stripSignature: true,
        replyStyleEnabled: false,
        replyGreeting: null,
        replySignature: null,
      },
    )

    const context = await getParsingProfileContext(ACCOUNT)
    expect(context.parsingPreferences['alice@example.com']).toEqual({
      stripQuotedHistory: false,
      stripGreeting: false,
      stripSignature: false,
    })

    const parsed = toParsedMessage(
      message({
        id: 'profile-message',
        threadId: 'profile-thread',
        from: 'Alice <alice@example.com>',
        subject: 'Project',
        date: 'Mon, 15 Jan 2024 10:00:00 +0000',
        body: 'Hi Alex,\n\nA reply.\n\nBest,\nAlice\n\nOn Monday Alex wrote:\n> Original.',
      }),
    )
    const conversation = buildConversation([parsed], {
      ownerEmail: ACCOUNT,
      gmailThreadId: 'profile-thread',
      ...context,
    })
    expect(conversation.messages[0].body).toContain('Hi Alex,')
    expect(conversation.messages[0].body).toContain('Best,')
    expect(conversation.messages[0].body).toContain('On Monday Alex wrote:')
    expect(conversation.messages[0].strippedQuote).toBeNull()
  })
})

describe('conversation detail edits', () => {
  test('persists and clears the user-owned topic and goal', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 'details-thread',
          historyId: '900',
          messages: [
            message({
              id: 'details-message',
              threadId: 'details-thread',
              from: 'alice@example.com',
              subject: 'Project launch',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'Can you confirm Tuesday?',
            }),
          ],
        },
      ],
    })

    await backfill(client, ACCOUNT)
    await setConversationDetails(ACCOUNT, 'details-thread', {
      topic: 'Launch schedule',
      goal: 'Confirm a Tuesday launch',
    })
    const [saved] = await listConversations(ACCOUNT)
    expect(saved.topic).toBe('Launch schedule')
    expect(saved.goal).toBe('Confirm a Tuesday launch')

    await setConversationDetails(ACCOUNT, 'details-thread', {
      topic: null,
      goal: null,
    })
    const [cleared] = await listConversations(ACCOUNT)
    expect(cleared.topic).toBeNull()
    expect(cleared.goal).toBeNull()
  })
})

describe('replyability', () => {
  test('a human thread is replyable, a no-reply sender is not', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 'human-thread',
          historyId: '900',
          messages: [
            message({
              id: 'm1',
              threadId: 'human-thread',
              from: 'sarah@example.com',
              subject: 'Project',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'Can you confirm Tuesday?',
            }),
          ],
        },
        {
          id: 'robot-thread',
          historyId: '901',
          messages: [
            message({
              id: 'm2',
              threadId: 'robot-thread',
              from: 'GitHub <noreply@github.com>',
              subject: 'Build failed',
              date: 'Mon, 15 Jan 2024 11:00:00 +0000',
              body: 'Build #881 failed.',
            }),
          ],
        },
      ],
    })

    await backfill(client, ACCOUNT)
    const stored = await listConversations(ACCOUNT)
    const human = stored.find((c) => c.gmailThreadId === 'human-thread')
    const robot = stored.find((c) => c.gmailThreadId === 'robot-thread')

    expect(human?.isAutomated).toBe(false)
    expect(human?.replyable).toBe(true)
    // The deterministic machine-mail marker settles automation before Jev.
    expect(robot?.isAutomated).toBe(true)
    expect(robot?.replyable).toBe(false)
  })

  test('re-analyse recomputes the stored decision without a Gmail call', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 'reanalyse-thread',
          historyId: '900',
          messages: [
            message({
              id: 'm1',
              threadId: 'reanalyse-thread',
              from: 'sarah@example.com',
              subject: 'Project',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'Can you confirm Tuesday?',
            }),
          ],
        },
      ],
    })

    await backfill(client, ACCOUNT)

    // Simulate a classification written before the thread last changed: stale
    // state and a wrongly cleared replyability.
    const { eq } = await import('drizzle-orm')
    await db
      .update(conversations)
      .set({ state: 'informational', replyable: false })
      .where(eq(conversations.gmailThreadId, 'reanalyse-thread'))

    // Re-analyse must not talk to Gmail; the assertion below covers the whole call.
    client.calls.length = 0

    const { reanalyseConversation } = await import('./service.ts')
    await reanalyseConversation('reanalyse-thread')

    const [updated] = await listConversations(ACCOUNT)
    expect(updated.state).toBe('needs-action')
    expect(updated.replyable).toBe(true)
    // Re-analyse runs the local pipeline only — no thread was fetched.
    expect(client.calls.some((c) => c.startsWith('getThread'))).toBe(false)
  })
})

describe('fragmented threads across two mailboxes', () => {
  // The bug this guards: Gmail does not always group a message the same way in
  // the sender's and recipient's mailboxes. Here one mailbox holds the whole
  // thread and the other holds each message as its own thread — the inbox merges
  // them by Message-ID, but the detail view used to load only the single thread
  // its id named, so opening a merged row showed a one-message fragment.
  const OTHER = 'other@example.com'

  function parsedMessage(args: {
    from: string
    to: string
    messageId: string
    date: string
    body: string
  }) {
    return {
      subject: 'This is a test',
      from: args.from,
      to: [args.to],
      cc: [],
      date: new Date(args.date),
      messageId: args.messageId,
      parts: [{ contentType: 'text/plain', text: args.body }],
    }
  }

  test('resolves a fragment to the whole merged conversation', async () => {
    const { buildConversation, saveConversation } = await import(
      '#/lib/conversation/index.ts'
    )
    await db.insert(accounts).values({
      id: OTHER,
      email: OTHER,
      refreshTokenEncrypted: 'v1:a:b:c',
    })

    const m1 = parsedMessage({
      from: ACCOUNT,
      to: OTHER,
      messageId: '<m1@example.com>',
      date: 'Mon, 15 Jan 2024 10:00:00 +0000',
      body: 'First.',
    })
    const m2 = parsedMessage({
      from: OTHER,
      to: ACCOUNT,
      messageId: '<m2@example.com>',
      date: 'Mon, 15 Jan 2024 11:00:00 +0000',
      body: 'Second.',
    })

    // One complete thread in the first mailbox...
    await saveConversation(
      ACCOUNT,
      buildConversation([m1, m2], {
        ownerEmail: ACCOUNT,
        gmailThreadId: 'complete-thread',
      }),
    )

    // ...and two single-message fragments in the other, for the same messages.
    await saveConversation(
      OTHER,
      buildConversation([m1], {
        ownerEmail: OTHER,
        gmailThreadId: 'fragment-one',
      }),
    )
    await saveConversation(
      OTHER,
      buildConversation([m2], {
        ownerEmail: OTHER,
        gmailThreadId: 'fragment-two',
      }),
    )

    const { loadConversation } = await import('./service.ts')

    // Loading the *fragment* must still show the whole conversation.
    const detail = await loadConversation('fragment-one')
    expect(detail).not.toBeNull()
    // The DTO does not expose Message-IDs; the bodies identify both messages.
    expect(detail?.messages.map((m) => m.body)).toEqual(['First.', 'Second.'])
    // The canonical row is the owner's most complete copy, not the fragment.
    expect(detail?.gmailThreadId).toBe('complete-thread')
    expect(detail?.accountId).toBe(ACCOUNT)
    expect(detail?.ownerEmails).toEqual([ACCOUNT, OTHER])

    // Both ways into the cluster resolve to the same conversation.
    const fromComplete = await loadConversation('complete-thread')
    expect(fromComplete?.messages.map((m) => m.body)).toEqual([
      'First.',
      'Second.',
    ])
    expect(fromComplete?.gmailThreadId).toBe('complete-thread')
  })
})

describe('backfill', () => {
  test('persists conversations for every thread', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 't1',
          historyId: '900',
          messages: [
            message({
              id: 'm1',
              threadId: 't1',
              from: 'Sarah <sarah@example.com>',
              subject: 'Project launch',
              date: 'Mon, 15 Jan 2024 10:00:00 +0100',
              body: 'Hi Alex,\n\nCan we move the launch to Tuesday?\n\nThanks,\nSarah',
            }),
          ],
        },
        {
          id: 't2',
          historyId: '901',
          messages: [
            message({
              id: 'm2',
              threadId: 't2',
              from: 'bob@example.com',
              subject: 'Invoice',
              date: 'Tue, 16 Jan 2024 09:00:00 +0100',
              body: 'Your invoice is attached.',
            }),
          ],
        },
      ],
    })

    const result = await backfill(client, ACCOUNT)

    expect(result.synced).toBe(2)
    expect(result.skipped).toBe(0)

    const stored = await listConversations(ACCOUNT)
    expect(stored).toHaveLength(2)
  })

  test('cleans bodies and derives state from the message flow', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 't1',
          historyId: '900',
          messages: [
            message({
              id: 'm1',
              threadId: 't1',
              from: 'Sarah <sarah@example.com>',
              subject: 'Project launch',
              date: 'Mon, 15 Jan 2024 10:00:00 +0100',
              body: 'Hi Alex,\n\nCan we move the launch to Tuesday?\n\nThanks,\nSarah',
            }),
          ],
        },
      ],
    })

    await backfill(client, ACCOUNT)
    const [conversation] = await listConversations(ACCOUNT)

    expect(conversation.subject).toBe('Project launch')
    expect(conversation.messages[0].body).toBe(
      'Can we move the launch to Tuesday?',
    )
    expect(conversation.messages[0].greeting).toBe('Hi Alex,')
    expect(conversation.state).toBe('needs-action')
  })

  test('excludes drafts and trashed messages', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 't1',
          historyId: '900',
          messages: [
            message({
              id: 'm1',
              threadId: 't1',
              from: 's@e.com',
              subject: 'Real',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'Actual message.',
            }),
            message({
              id: 'm2',
              threadId: 't1',
              from: ACCOUNT,
              subject: 'Draft',
              date: 'Mon, 15 Jan 2024 11:00:00 +0000',
              body: 'Unsent draft.',
              labels: ['DRAFT'],
            }),
            message({
              id: 'm3',
              threadId: 't1',
              from: 's@e.com',
              subject: 'Deleted',
              date: 'Mon, 15 Jan 2024 12:00:00 +0000',
              body: 'Trashed thing.',
              labels: ['TRASHED'],
            }),
          ],
        },
      ],
    })

    await backfill(client, ACCOUNT)
    const [conversation] = await listConversations(ACCOUNT)

    expect(conversation.messageCount).toBe(1)
    expect(conversation.messages[0].body).toBe('Actual message.')
  })

  test('skips a thread with no relevant messages', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 't1',
          historyId: '900',
          messages: [
            message({
              id: 'm1',
              threadId: 't1',
              from: ACCOUNT,
              subject: 'Draft only',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'Draft.',
              labels: ['DRAFT'],
            }),
          ],
        },
      ],
    })

    const result = await backfill(client, ACCOUNT)
    expect(result.synced).toBe(0)
    expect(result.skipped).toBe(1)
  })

  test('paginates through thread listings', async () => {
    const threads = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`,
      historyId: '900',
      messages: [
        message({
          id: `m${i}`,
          threadId: `t${i}`,
          from: 's@e.com',
          subject: `Subject ${i}`,
          date: 'Mon, 15 Jan 2024 10:00:00 +0000',
          body: `Message ${i}`,
        }),
      ],
    }))

    const client = new FakeGmailClient({ threads, pageSize: 2 })

    const result = await backfill(client, ACCOUNT)

    expect(result.synced).toBe(5)
    // 5 threads at 2 per page = 3 listing calls.
    const listCalls = client.calls.filter((c) => c.startsWith('listThreads'))
    expect(listCalls).toHaveLength(3)
  })

  test('respects the limit and stops paginating early', async () => {
    const threads = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      historyId: '900',
      messages: [
        message({
          id: `m${i}`,
          threadId: `t${i}`,
          from: 's@e.com',
          subject: `S${i}`,
          date: 'Mon, 15 Jan 2024 10:00:00 +0000',
          body: `Body ${i}`,
        }),
      ],
    }))

    const client = new FakeGmailClient({ threads, pageSize: 2 })
    const result = await backfill(client, ACCOUNT, { limit: 3 })

    expect(result.synced).toBe(3)
  })

  test('one failing thread does not abort the whole sync', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 'good',
          historyId: '900',
          messages: [
            message({
              id: 'm1',
              threadId: 'good',
              from: 's@e.com',
              subject: 'Fine',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'This one works.',
            }),
          ],
        },
        {
          id: 'bad',
          historyId: '900',
          messages: [
            message({
              id: 'm2',
              threadId: 'bad',
              from: 's@e.com',
              subject: 'Broken',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'This one fails.',
            }),
          ],
        },
      ],
      failThread: (id) => (id === 'bad' ? new Error('boom') : null),
    })

    const errors: string[] = []
    const result = await backfill(client, ACCOUNT, {
      onProgress: (e) => {
        if (e.type === 'error') errors.push(e.threadId)
      },
    })

    expect(result.synced).toBe(1)
    expect(result.skipped).toBe(1)
    expect(errors).toContain('bad')

    const stored = await listConversations(ACCOUNT)
    expect(stored.map((c) => c.gmailThreadId)).toEqual(['good'])
  })

  test('stores attachment metadata without downloading bytes', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 't1',
          historyId: '900',
          messages: [
            {
              id: 'm1',
              threadId: 't1',
              labelIds: ['INBOX'],
              internalDate: String(Date.now()),
              snippet: '',
              payload: normalizePart(
                multipartPayload({
                  headers: { from: 's@e.com', subject: 'Report' },
                  text: 'See attached.',
                  attachment: {
                    filename: 'q1.pdf',
                    mimeType: 'application/pdf',
                    attachmentId: 'att-1',
                    size: 4096,
                  },
                }),
              ),
            },
          ],
        },
      ],
    })

    await backfill(client, ACCOUNT)
    const [conversation] = await listConversations(ACCOUNT)

    expect(conversation.attachmentCount).toBe(1)
    expect(conversation.attachments[0].filename).toBe('q1.pdf')
    expect(conversation.attachments[0].sizeBytes).toBe(4096)

    // No attachment bytes were fetched during sync.
    expect(client.calls.some((c) => c.startsWith('getAttachment'))).toBe(false)
  })

  test('saves a thread whose attachment-bearing message has a Message-ID header', async () => {
    // The messages row is keyed by the parsed `messageId` — the RFC 5322
    // Message-ID when the mail carries one — so the attachment's foreign key has
    // to reference that same value. Keying it by Gmail's own message id instead
    // left the FK pointing at no row, and every real thread with an attachment
    // failed to save as a whole. The no-Message-ID case above hid this because
    // the fallback made both ids coincide.
    const client = new FakeGmailClient({
      threads: [
        {
          id: 't1',
          historyId: '900',
          messages: [
            {
              id: 'm1',
              threadId: 't1',
              labelIds: ['INBOX'],
              internalDate: String(Date.now()),
              snippet: '',
              payload: normalizePart(
                multipartPayload({
                  headers: {
                    from: 's@e.com',
                    subject: 'Report',
                    'Message-ID': '<abc123@mail.example.com>',
                  },
                  text: 'See attached.',
                  attachment: {
                    filename: 'q1.pdf',
                    mimeType: 'application/pdf',
                    attachmentId: 'att-1',
                    size: 4096,
                  },
                }),
              ),
            },
          ],
        },
      ],
    })

    const result = await backfill(client, ACCOUNT)
    expect(result.synced).toBe(1)

    const [conversation] = await listConversations(ACCOUNT)
    expect(conversation.attachmentCount).toBe(1)
    expect(conversation.attachments[0].filename).toBe('q1.pdf')
  })

  test('re-saving a stored conversation keeps its attachments addressable', async () => {
    // Re-analysis loads a conversation from the database and persists it again.
    // The stored attachment points at a message by its row id, and re-saving
    // used to prefix that a second time — a foreign key matching no row, so the
    // save failed. The same value is what the chat view groups chips by.
    const client = new FakeGmailClient({
      threads: [
        {
          id: 't1',
          historyId: '900',
          messages: [
            {
              id: 'm1',
              threadId: 't1',
              labelIds: ['INBOX'],
              internalDate: String(Date.now()),
              snippet: '',
              payload: normalizePart(
                multipartPayload({
                  headers: {
                    from: 's@e.com',
                    subject: 'Report',
                    'Message-ID': '<abc123@mail.example.com>',
                  },
                  text: 'See attached.',
                  attachment: {
                    filename: 'q1.pdf',
                    mimeType: 'application/pdf',
                    attachmentId: 'att-1',
                    size: 4096,
                  },
                }),
              ),
            },
          ],
        },
      ],
    })

    await backfill(client, ACCOUNT)

    const loaded = await getConversation(ACCOUNT, 't1')
    expect(loaded?.attachments).toHaveLength(1)

    // The chat view matches a chip to its bubble through this value.
    const attachmentMessageId = loaded?.attachments[0]?.gmailMessageId
    expect(loaded?.messages.map((m) => m.gmailMessageId)).toContain(
      attachmentMessageId,
    )

    await expect(saveConversation(ACCOUNT, loaded!)).resolves.toBeUndefined()
  })

  test('records a decision for every synced conversation', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 't1',
          historyId: '900',
          messages: [
            message({
              id: 'm1',
              threadId: 't1',
              from: 'sarah@example.com',
              subject: 'Project',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'Can you confirm Tuesday?',
            }),
          ],
        },
      ],
    })

    await backfill(client, ACCOUNT)

    // The seam is now actually invoked by sync, not just defined.
    const rows = await db.select().from(decisions)
    expect(rows).toHaveLength(1)
    expect(rows[0].provider).toBe('rules+rules+none')
    expect(rows[0].state).toBe('needs-action')
    expect(rows[0].reasoning).toBeTruthy()
  })

  test('advances the history cursor', async () => {
    const client = new FakeGmailClient({
      threads: [],
      historyId: '55555',
    })

    const result = await backfill(client, ACCOUNT)
    expect(result.historyId).toBe('55555')
    expect(client.calls).toContain('getProfileHistoryId')
  })
})

describe('syncIncremental', () => {
  test('refetches only threads that changed', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 't1',
          historyId: '910',
          messages: [
            message({
              id: 'm1',
              threadId: 't1',
              from: 's@e.com',
              subject: 'Changed',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'New content.',
            }),
          ],
        },
      ],
      history: {
        '1000': {
          history: [{ id: '1001', messages: [{ id: 'm1', threadId: 't1' }] }],
          nextPageToken: null,
          historyId: '1001',
        },
      },
    })

    const result = await syncIncremental(client, ACCOUNT, '1000')

    expect(result.synced).toBe(1)
    const threadFetches = client.calls.filter((c) => c.startsWith('getThread'))
    expect(threadFetches).toEqual(['getThread:t1'])
  })

  test('dedupes thread ids across history records', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 't1',
          historyId: '910',
          messages: [
            message({
              id: 'm1',
              threadId: 't1',
              from: 's@e.com',
              subject: 'X',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'Body',
            }),
          ],
        },
      ],
      history: {
        '1000': {
          history: [
            { id: '1001', messages: [{ id: 'm1', threadId: 't1' }] },
            { id: '1002', messages: [{ id: 'm1', threadId: 't1' }] },
          ],
          nextPageToken: null,
          historyId: '1002',
        },
      },
    })

    await syncIncremental(client, ACCOUNT, '1000')

    const threadFetches = client.calls.filter((c) => c.startsWith('getThread'))
    expect(threadFetches).toHaveLength(1)
  })

  test('throws when the cursor has expired', async () => {
    const client = new FakeGmailClient({ threads: [] })
    await expect(syncIncremental(client, ACCOUNT, 'stale')).rejects.toThrow(
      /no longer available/i,
    )
  })
})

describe('sync', () => {
  test('falls back to backfill when the cursor is stale', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 't1',
          historyId: '910',
          messages: [
            message({
              id: 'm1',
              threadId: 't1',
              from: 's@e.com',
              subject: 'Recovered',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'Rebuilt from scratch.',
            }),
          ],
        },
      ],
      // No history entry for 'stale', so listHistory throws NotFound.
    })

    const result = await sync(client, ACCOUNT, { startHistoryId: 'stale' })

    expect(result.synced).toBe(1)
    const stored = await listConversations(ACCOUNT)
    expect(stored).toHaveLength(1)
  })

  test('uses incremental when a cursor exists', async () => {
    const client = new FakeGmailClient({
      threads: [
        {
          id: 't1',
          historyId: '910',
          messages: [
            message({
              id: 'm1',
              threadId: 't1',
              from: 's@e.com',
              subject: 'X',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'Body',
            }),
          ],
        },
      ],
      history: {
        '1000': {
          history: [{ id: '1001', messages: [{ id: 'm1', threadId: 't1' }] }],
          nextPageToken: null,
          historyId: '1001',
        },
      },
    })

    const result = await sync(client, ACCOUNT, { startHistoryId: '1000' })

    expect(result.synced).toBe(1)
    expect(client.calls.some((c) => c.startsWith('listThreads'))).toBe(false)
  })
})

describe('AI settings', () => {
  test('stores keys encrypted and builds the pipeline config without leaking them', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)
    const { getAiPipelineConfig, getAiSettings, saveAiSettings } = await import(
      '#/lib/ai/settings.ts'
    )

    await saveAiSettings({
      jevModel: 'jev-latest',
      llmProvider: 'gemini',
      llmModel: null,
      jevApiKey: 'jev-secret',
      llmApiKey: 'llm-secret',
    })

    const summary = await getAiSettings()
    expect(summary.jevConfigured).toBe(true)
    expect(summary.llmProvider).toBe('gemini')
    expect(summary.llmConfigured).toBe(true)
    // The summary shown to the browser never contains a secret.
    expect(JSON.stringify(summary)).not.toContain('jev-secret')
    expect(JSON.stringify(summary)).not.toContain('llm-secret')

    const config = await getAiPipelineConfig()
    expect(config.jev).toEqual({ apiKey: 'jev-secret', model: 'jev-latest' })
    expect(config.llm).toEqual({
      provider: 'gemini',
      apiKey: 'llm-secret',
      model: 'gemini-2.5-flash',
    })
  })

  test('leaves a key unchanged when omitted and clears it when emptied', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)
    const { getAiPipelineConfig, getAiSettings, saveAiSettings } = await import(
      '#/lib/ai/settings.ts'
    )

    await saveAiSettings({
      jevModel: null,
      llmProvider: null,
      llmModel: null,
      jevApiKey: 'first',
    })
    expect((await getAiPipelineConfig()).jev?.apiKey).toBe('first')

    // Omitting the key leaves it as-is.
    await saveAiSettings({ jevModel: null, llmProvider: null, llmModel: null })
    expect((await getAiPipelineConfig()).jev?.apiKey).toBe('first')

    // An empty string clears it.
    await saveAiSettings({
      jevModel: null,
      llmProvider: null,
      llmModel: null,
      jevApiKey: '',
    })
    expect((await getAiPipelineConfig()).jev).toBeNull()
    expect((await getAiSettings()).jevConfigured).toBe(false)
  })
})

describe('safeFilename', () => {
  test('strips directory traversal', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd')
    expect(safeFilename('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe')
    expect(safeFilename('/absolute/path/file.txt')).toBe('file.txt')
  })

  test('neutralises reserved Windows device names', () => {
    expect(safeFilename('CON')).toBe('_CON')
    expect(safeFilename('lpt1.txt')).toBe('_lpt1.txt')
  })

  test('replaces characters illegal on Windows', () => {
    expect(safeFilename('re<port>:final?.txt')).toBe('re_port__final_.txt')
  })

  test('never returns an empty or dot name', () => {
    expect(safeFilename('')).toBe('attachment')
    expect(safeFilename('.')).toBe('attachment')
    expect(safeFilename('..')).toBe('attachment')
  })

  test('keeps the extension and caps length', () => {
    const long = `${'a'.repeat(300)}.txt`
    const safe = safeFilename(long)
    expect(safe.length).toBeLessThanOrEqual(120)
    expect(safe.endsWith('.txt')).toBe(true)
  })

  test('preserves a normal filename untouched', () => {
    expect(safeFilename('quarterly-report.pdf')).toBe('quarterly-report.pdf')
  })
})

describe('attachment limits', () => {
  test('the default cap is a sane size', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024)
  })
})
