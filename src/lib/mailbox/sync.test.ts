import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

// Type-only, so it is erased and does not evaluate `sync.ts` before the database
// environment is set up the way the value imports below are careful to.
import type { SyncEvent } from '#/lib/mailbox/sync.ts'

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
const {
  accounts,
  appSettings,
  attachments: attachmentsTable,
  conversations,
  decisions,
  messages,
  senderProfiles,
  users,
} = await import('#/db/schema.ts')
const { FakeMailboxClient } = await import('#/lib/mailbox/fake.ts')
const { backfill, syncIncremental, sync } =
  await import('#/lib/mailbox/sync.ts')
const { refreshThread } = await import('#/lib/gmail/send.ts')
const { toParsedMessage, toAttachmentRefs } =
  await import('#/lib/mailbox/message.ts')
const { decodeGmailData } = await import('#/lib/mailbox/message.ts')
const { safeFilename, MAX_ATTACHMENT_BYTES } =
  await import('#/lib/gmail/attachments.ts')
const {
  getConversation,
  getParsingProfileContext,
  getStoredAttachment,
  listConversations,
  saveConversation,
  saveParsingProfile,
  setConversationDetails,
} = await import('#/lib/conversation/index.ts')
const { draftReply, forgetAccount, loadAttachment, loadInbox } =
  await import('#/lib/gmail/service.ts')
const { removeAttachmentCache } = await import('#/lib/gmail/attachments.ts')

const { migrate } = await import('drizzle-orm/libsql/migrator')
await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const ACCOUNT = 'me@example.com'
/**
 * The person these tests are signed in as.
 *
 * Every service entry point is scoped by user now, so the fixture has to own the
 * mailbox it syncs — an account with no owner is invisible to the very queries
 * these tests drive.
 */
const USER = 'owner@example.com'

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
  // Cleared here too: these rows are another form of stored user preference, and
  // a sender marked in one test would otherwise decide the next one's outcome.
  await db.delete(senderProfiles)
  await db.delete(accounts)
  await db.delete(users)

  await db.insert(users).values({
    id: USER,
    email: USER,
    passwordHash: 'not-a-real-hash',
  })

  await db.insert(accounts).values({
    id: ACCOUNT,
    userId: USER,
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
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 'sender-profile-thread',
          cursor: '901',
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

    await backfill(client, ACCOUNT, { userId: USER })
    const saved = (await listConversations(ACCOUNT)).find(
      (item) => item.providerThreadId === 'sender-profile-thread',
    )
    expect(saved?.messages[0].body).toContain('Hi Alex,')
    expect(saved?.messages[0].body).toContain('On Monday Alex wrote:')
    expect(saved?.messages[0].strippedGreeting).toBeNull()
    expect(saved?.messages[0].strippedSignature ?? '').toContain('Best,')
    expect(saved?.messages[0].strippedQuote).toBeNull()

    const { loadConversation } = await import('#/lib/gmail/service.ts')
    const detail = await loadConversation(USER, 'sender-profile-thread')
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
      providerThreadId: 'profile-thread',
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
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 'details-thread',
          cursor: '900',
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

    await backfill(client, ACCOUNT, { userId: USER })
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
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 'human-thread',
          cursor: '900',
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
          cursor: '901',
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

    await backfill(client, ACCOUNT, { userId: USER })
    const stored = await listConversations(ACCOUNT)
    const human = stored.find((c) => c.providerThreadId === 'human-thread')
    const robot = stored.find((c) => c.providerThreadId === 'robot-thread')

    expect(human?.isAutomated).toBe(false)
    expect(human?.replyable).toBe(true)
    // The deterministic machine-mail marker settles automation before Jev.
    expect(robot?.isAutomated).toBe(true)
    expect(robot?.replyable).toBe(false)
  })

  test('re-analyse recomputes the stored decision without a Gmail call', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 'reanalyse-thread',
          cursor: '900',
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

    await backfill(client, ACCOUNT, { userId: USER })

    // Simulate a classification written before the thread last changed: stale
    // state and a wrongly cleared replyability.
    const { eq } = await import('drizzle-orm')
    await db
      .update(conversations)
      .set({ state: 'informational', replyable: false })
      .where(eq(conversations.providerThreadId, 'reanalyse-thread'))

    // Re-analyse must not talk to Gmail; the assertion below covers the whole call.
    client.calls.length = 0

    const { reanalyseConversation } = await import('#/lib/gmail/service.ts')
    await reanalyseConversation(USER, 'reanalyse-thread')

    const [updated] = await listConversations(ACCOUNT)
    expect(updated.state).toBe('needs-action')
    expect(updated.replyable).toBe(true)
    // Re-analyse runs the local pipeline only — no thread was fetched.
    expect(client.calls.some((c) => c.startsWith('getThread'))).toBe(false)
  })
})

/**
 * Reading a thread and finishing with it — the two different questions.
 *
 * Opening a thread records that it was read; only the user's own Done mark says
 * they have dealt with it. A design that conflated the two would mark a thread
 * handled the moment it was opened, which is exactly when a reply is most likely
 * to be forgotten.
 */
describe('reading a thread and marking it done', () => {
  /** A human thread from an ordinary address — the case that needs both marks. */
  function humanThread(id: string, messageId: string, date: string): any {
    return {
      id,
      cursor: '900',
      messages: [
        message({
          id: messageId,
          threadId: id,
          from: 'alice@example.com',
          subject: 'Project launch',
          date,
          body: 'Can you confirm Tuesday?',
        }),
      ],
    }
  }

  test('opening records the read mark, moves nothing else, and never goes backwards', async () => {
    const client = new FakeMailboxClient({
      threads: [
        humanThread('read-thread', 'm1', 'Mon, 15 Jan 2024 10:00:00 +0000'),
      ],
    })
    await backfill(client, ACCOUNT, { userId: USER })

    const { loadConversation, markConversationSeen } =
      await import('#/lib/gmail/service.ts')

    const before = await loadConversation(USER, 'read-thread')
    expect(before?.seenAt).toBeNull()
    expect(before?.done).toBe(false)

    // The instant the view had on screen, reported back verbatim.
    const onScreen = before?.messages.at(-1)?.sentAt ?? ''
    await markConversationSeen(USER, 'read-thread', onScreen)

    const after = await loadConversation(USER, 'read-thread')
    expect(after?.seenAt).toBe(onScreen)
    // Read is not done — the whole reason the two are stored separately.
    expect(after?.done).toBe(false)
    // And reading never moves the state the decision layer put the thread in.
    expect(after?.state).toBe('needs-action')

    // An older mark — a stale tab, or a thread opened before this one — must not
    // un-read newer mail.
    await markConversationSeen(USER, 'read-thread', '2024-01-01T00:00:00.000Z')
    const [row] = await listConversations(ACCOUNT)
    expect(row.seenAt?.toISOString()).toBe(onScreen)

    // A time that does not parse is refused rather than guessed at.
    await expect(
      markConversationSeen(USER, 'read-thread', 'yesterday'),
    ).rejects.toThrow(/not a valid time/i)
  })

  test('the done mark survives every rebuild and comes back when new mail arrives', async () => {
    const client = new FakeMailboxClient({
      threads: [
        humanThread('done-thread', 'm1', 'Mon, 15 Jan 2024 10:00:00 +0000'),
      ],
    })
    await backfill(client, ACCOUNT, { userId: USER })

    const { loadConversation, setConversationDone } =
      await import('#/lib/gmail/service.ts')
    await setConversationDone(USER, 'done-thread', true)

    const marked = await loadConversation(USER, 'done-thread')
    expect(marked?.done).toBe(true)
    // "Done" is the user's answer about whether they have dealt with the mail,
    // not a claim about what it needs, so the state stays where it was.
    expect(marked?.state).toBe('needs-action')

    // Every path that rebuilds a thread from Gmail knows nothing about the mark,
    // so these are the places it would be lost: a re-sync, a re-decide, and the
    // send path's own rebuild (`refreshThread`).
    await backfill(client, ACCOUNT, { userId: USER })
    expect((await loadConversation(USER, 'done-thread'))?.done).toBe(true)

    const { redecideStoredConversations } =
      await import('#/lib/mailbox/sync.ts')
    await redecideStoredConversations(ACCOUNT, USER)
    expect((await loadConversation(USER, 'done-thread'))?.done).toBe(true)

    await refreshThread(client, ACCOUNT, 'done-thread')
    expect((await loadConversation(USER, 'done-thread'))?.done).toBe(true)

    // New mail is precisely what the mark must not swallow: the thread comes back
    // on its own, and the user does not have to notice that it did.
    client.setThread(
      humanThread('done-thread', 'm2', 'Tue, 16 Jan 2024 10:00:00 +0000'),
    )
    await backfill(client, ACCOUNT, { userId: USER })
    expect((await loadConversation(USER, 'done-thread'))?.done).toBe(false)

    // Saying so again works, and so does taking it back.
    await setConversationDone(USER, 'done-thread', true)
    expect((await loadConversation(USER, 'done-thread'))?.done).toBe(true)
    await setConversationDone(USER, 'done-thread', false)
    expect((await loadConversation(USER, 'done-thread'))?.done).toBe(false)
  })
})

/**
 * Answering "I cannot reply to this sender" once, for all of their mail.
 *
 * The case this is for is a company writing from an ordinary address —
 * `updates@`, `account@` — with mail there is nothing to answer: a view-only
 * notice, an invoice, a statement. The marker does not fire on those addresses
 * and Jev can only guess from the writing, so the user is the only one who knows
 * — and the answer has to hold for every thread from that sender, not just the
 * one they clicked.
 */
describe('marking a sender as one you cannot reply to', () => {
  /** A view-only notice from an address no marker recognises. */
  function notice(threadId: string, messageId: string, from: string): any {
    return {
      id: threadId,
      cursor: '900',
      messages: [
        message({
          id: messageId,
          threadId,
          from,
          subject: 'Your invoice is ready',
          date: 'Mon, 15 Jan 2024 10:00:00 +0000',
          body: 'View your invoice online.',
        }),
      ],
    }
  }

  test('covers every stored thread from that sender, and the mail that arrives later', async () => {
    const client = new FakeMailboxClient({
      threads: [
        notice('invoice-1', 'm1', 'updates@acme.example'),
        notice('invoice-2', 'm2', 'updates@acme.example'),
        notice('other-1', 'm3', 'billing@other.example'),
      ],
    })
    await backfill(client, ACCOUNT, { userId: USER })

    // Nothing here is machine mail: an ordinary address, and nothing in the body
    // the rules read as "nobody to answer".
    const before = await listConversations(ACCOUNT)
    expect(before.every((c) => c.replyable)).toBe(true)

    const { applySenderReplyabilityToSender } =
      await import('#/lib/gmail/service.ts')
    await applySenderReplyabilityToSender(
      USER,
      ACCOUNT,
      'updates@acme.example',
      false,
    )

    const marked = await listConversations(ACCOUNT)
    const one = (id: string) => marked.find((c) => c.providerThreadId === id)
    expect(one('invoice-1')?.replyable).toBe(false)
    // The sweep covers threads the decision layer will not revisit — it only
    // runs on mail Gmail reports as changed.
    expect(one('invoice-2')?.replyable).toBe(false)
    // Another sender is untouched.
    expect(one('other-1')?.replyable).toBe(true)
    // The state is left where the user found it: "hide the composer only".
    expect(one('invoice-1')?.state).toBe('informational')

    // Mail from the sender that arrives afterwards reads the stored answer
    // instead of guessing from the address again.
    client.setThread(notice('invoice-3', 'm4', 'updates@acme.example'))
    await backfill(client, ACCOUNT, { userId: USER })
    expect(
      (await listConversations(ACCOUNT)).find(
        (c) => c.providerThreadId === 'invoice-3',
      )?.replyable,
    ).toBe(false)

    // A rebuild from Gmail knows nothing about the mark, so these are the places
    // it would be lost. The send path is the quietest one: it rebuilds the thread
    // and saves it without running the decision layer at all.
    // `refreshThread` is imported at the top of this file already.
    await refreshThread(client, ACCOUNT, 'invoice-2')
    expect(
      (await listConversations(ACCOUNT)).find(
        (c) => c.providerThreadId === 'invoice-2',
      )?.replyable,
    ).toBe(false)

    await backfill(client, ACCOUNT, { userId: USER })
    const { redecideStoredConversations } =
      await import('#/lib/mailbox/sync.ts')
    await redecideStoredConversations(ACCOUNT, USER)
    expect(
      (await listConversations(ACCOUNT)).find(
        (c) => c.providerThreadId === 'invoice-2',
      )?.replyable,
    ).toBe(false)

    // Taking the mark back brings the composer back on all of them.
    await applySenderReplyabilityToSender(
      USER,
      ACCOUNT,
      'updates@acme.example',
      true,
    )
    expect((await listConversations(ACCOUNT)).every((c) => c.replyable)).toBe(
      true,
    )
  })

  test('marks an address that has no mail yet, and the thread that arrives reads it', async () => {
    // The list lives in Settings, where there is no thread to pick a sender from,
    // so an entry has to be able to exist before its mail does — and the mail
    // that follows is the part that must still be covered.
    const client = new FakeMailboxClient({
      threads: [notice('invoice-1', 'm1', 'updates@acme.example')],
    })
    await backfill(client, ACCOUNT, { userId: USER })

    const { applySenderReplyabilityToSender } =
      await import('#/lib/gmail/service.ts')
    const { listUnreplyableSenders } =
      await import('#/lib/conversation/index.ts')

    await applySenderReplyabilityToSender(
      USER,
      ACCOUNT,
      'alerts@acme.example',
      false,
    )
    expect([...(await listUnreplyableSenders(ACCOUNT))]).toEqual([
      'alerts@acme.example',
    ])

    // Nothing was stored from that sender, so the sweep had nothing to change.
    // The next sync is where the entry has to do its work.
    client.setThread(notice('alert-1', 'm2', 'alerts@acme.example'))
    await backfill(client, ACCOUNT, { userId: USER })

    const stored = await listConversations(ACCOUNT)
    expect(
      stored.find((c) => c.providerThreadId === 'alert-1')?.replyable,
    ).toBe(false)
    // The entry is per sender, not a blanket: other senders keep their composer.
    expect(
      stored.find((c) => c.providerThreadId === 'invoice-1')?.replyable,
    ).toBe(true)
  })

  test('taking a mark back does not hand a composer to a no-reply address', async () => {
    // Undo is the user lifting their own answer. The machine-mail marker is not
    // theirs to lift, and `isAutomatedThread` stays the authority on it.
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 'robot-thread',
          cursor: '900',
          messages: [
            message({
              id: 'm1',
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
    await backfill(client, ACCOUNT, { userId: USER })

    const { applySenderReplyabilityToSender } =
      await import('#/lib/gmail/service.ts')
    await applySenderReplyabilityToSender(
      USER,
      ACCOUNT,
      'noreply@github.com',
      false,
    )
    await applySenderReplyabilityToSender(
      USER,
      ACCOUNT,
      'noreply@github.com',
      true,
    )

    const [thread] = await listConversations(ACCOUNT)
    expect(thread.replyable).toBe(false)
  })

  test('adding and lifting a sender refuses what the list cannot mean', async () => {
    // The list is typed, not picked, so every way the input can be wrong is a
    // branch the settings form can reach — checked here rather than through the
    // router, which is all this needs.
    const client = new FakeMailboxClient({
      threads: [notice('invoice-1', 'm1', 'updates@acme.example')],
    })
    await backfill(client, ACCOUNT, { userId: USER })

    const { addUnreplyableSender, removeUnreplyableSender } =
      await import('#/lib/gmail/service.ts')

    // A mailbox that is not connected cannot own the preference.
    expect(
      await addUnreplyableSender(
        USER,
        'other@elsewhere.example',
        'a@b.example',
      ),
    ).toEqual({ added: null, error: 'That mailbox is not connected.' })

    // Shape only: what could never be an address is refused ...
    for (const bad of ['nope', 'updates@', 'a@b.example c@d.example']) {
      expect((await addUnreplyableSender(USER, ACCOUNT, bad)).added).toBeNull()
    }
    // ... while an unusual one is stored: the list is a preference, not a
    // delivery, and `invoice@localhost` is a real address without a dot.
    expect(
      await addUnreplyableSender(USER, ACCOUNT, 'invoice@localhost'),
    ).toEqual({
      added: 'invoice@localhost',
      error: null,
    })

    // The user's own address would hide the composer on their own mail.
    expect((await addUnreplyableSender(USER, ACCOUNT, ACCOUNT)).error).toBe(
      `${ACCOUNT} is this mailbox's own address.`,
    )

    // Stored in its normalised form, and only once.
    expect(
      await addUnreplyableSender(USER, ACCOUNT, '  Alerts@Acme.Example '),
    ).toEqual({ added: 'alerts@acme.example', error: null })
    expect(
      (await addUnreplyableSender(USER, ACCOUNT, 'alerts@acme.example')).error,
    ).toBe('alerts@acme.example is already on the list.')

    // Undo refuses an entry that is not there, lifts one that is, and cannot
    // lift the same one twice.
    expect(
      (await removeUnreplyableSender(USER, ACCOUNT, 'never@acme.example'))
        .error,
    ).toBe('That sender is not marked as one you cannot reply to.')
    expect(
      await removeUnreplyableSender(USER, ACCOUNT, 'alerts@acme.example'),
    ).toEqual({ error: null })
    expect(
      (await removeUnreplyableSender(USER, ACCOUNT, 'alerts@acme.example'))
        .error,
    ).toBe('That sender is not marked as one you cannot reply to.')
  })

  test('marks the sender of the thread the user is looking at', async () => {
    // The one-click path. It names a *thread* rather than an address, so the
    // mailbox and the address both come from the mail on screen — nothing is
    // picked and nothing is typed.
    const client = new FakeMailboxClient({
      threads: [
        notice('invoice-1', 'm1', 'updates@acme.example'),
        notice('invoice-2', 'm2', 'updates@acme.example'),
        notice('other-1', 'm3', 'billing@other.example'),
      ],
    })
    await backfill(client, ACCOUNT, { userId: USER })

    const { markThreadSenderUnreplyable } =
      await import('#/lib/gmail/service.ts')
    const { listUnreplyableSenders } =
      await import('#/lib/conversation/index.ts')

    expect(await markThreadSenderUnreplyable(USER, 'invoice-2')).toEqual({
      error: null,
    })

    const stored = await listConversations(ACCOUNT)
    // Per sender rather than per thread: the sibling thread loses its reply box
    // too, which is the whole reason the mark is stored against the address.
    expect(
      stored.find((c) => c.providerThreadId === 'invoice-1')?.replyable,
    ).toBe(false)
    expect(
      stored.find((c) => c.providerThreadId === 'invoice-2')?.replyable,
    ).toBe(false)
    // And it lands on the one list, so Settings can take it back.
    expect([...(await listUnreplyableSenders(ACCOUNT))]).toEqual([
      'updates@acme.example',
    ])
    // Another sender is untouched.
    expect(
      stored.find((c) => c.providerThreadId === 'other-1')?.replyable,
    ).toBe(true)
  })

  test('refuses a thread with nobody on the other side', async () => {
    // A thread made only of the user's own messages has no sender, and writing the
    // owner's own address here would hide the composer on their own mail — so it
    // is refused rather than stored.
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 'self-thread',
          cursor: '900',
          messages: [
            message({
              id: 'm1',
              threadId: 'self-thread',
              from: ACCOUNT,
              subject: 'Note to self',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: 'Remember this.',
            }),
          ],
        },
      ],
    })
    await backfill(client, ACCOUNT, { userId: USER })

    const { markThreadSenderUnreplyable } =
      await import('#/lib/gmail/service.ts')
    const { listUnreplyableSenders } =
      await import('#/lib/conversation/index.ts')

    expect(await markThreadSenderUnreplyable(USER, 'self-thread')).toEqual({
      error: 'This conversation has no sender to mark.',
    })
    expect([...(await listUnreplyableSenders(ACCOUNT))]).toEqual([])
  })

  test('offers senders you can actually mark, newest first', async () => {
    const client = new FakeMailboxClient({
      threads: [
        notice('invoice-1', 'm1', 'updates@acme.example'),
        // A later message from the same address, this time with a display name.
        {
          id: 'invoice-2',
          cursor: '901',
          messages: [
            message({
              id: 'm2',
              threadId: 'invoice-2',
              from: 'Acme Updates <updates@acme.example>',
              subject: 'Your invoice is ready',
              date: 'Wed, 17 Jan 2024 10:00:00 +0000',
              body: 'View your invoice online.',
            }),
          ],
        },
        // Older, so it sorts below.
        {
          id: 'other-1',
          cursor: '903',
          messages: [
            message({
              id: 'm4',
              threadId: 'other-1',
              from: 'billing@other.example',
              subject: 'Your statement',
              date: 'Mon, 15 Jan 2024 09:00:00 +0000',
              body: 'View your statement online.',
            }),
          ],
        },
        // A machine sender: already unanswerable without anyone being asked, so
        // there is nothing a mark could add.
        {
          id: 'robot-1',
          cursor: '902',
          messages: [
            message({
              id: 'm3',
              threadId: 'robot-1',
              from: 'GitHub <noreply@github.com>',
              subject: 'Build failed',
              date: 'Thu, 18 Jan 2024 10:00:00 +0000',
              body: 'Build #881 failed.',
            }),
          ],
        },
      ],
    })
    await backfill(client, ACCOUNT, { userId: USER })

    const { listIncomingSenders } = await import('#/lib/conversation/index.ts')
    const owners = new Set([ACCOUNT])

    const senders = await listIncomingSenders(ACCOUNT, owners)
    expect(senders.map((sender) => sender.email)).toEqual([
      'updates@acme.example',
      'billing@other.example',
    ])
    // The name comes from the newer sighting, even though the first had none.
    expect(senders[0].name).toBe('Acme Updates')

    // The user's own address is never offered, even from the other side of a
    // thread between two of their mailboxes.
    expect(
      await listIncomingSenders(
        ACCOUNT,
        new Set([ACCOUNT, 'billing@other.example']),
      ),
    ).toEqual([senders[0]])

    // Marking one leaves nothing to offer: the list only names senders whose
    // stored threads still show a reply box.
    const { markThreadSenderUnreplyable } =
      await import('#/lib/gmail/service.ts')
    await markThreadSenderUnreplyable(USER, 'invoice-1')
    expect(
      (await listIncomingSenders(ACCOUNT, owners)).map((s) => s.email),
    ).toEqual(['billing@other.example'])
  })
})

/**
 * Drafts, and the gate in front of them.
 *
 * The expensive part of this feature is the API call, so what is worth testing
 * at this level is that ineligible threads never make one. Each case asserts the
 * *gate's own sentence*: if a call had gone out with the fake key stored here it
 * would have failed at the provider and produced a different message, so the
 * message is the proof that nothing was sent.
 */
describe('reply drafts', () => {
  /** A human asking a question — the thread a draft is actually for. */
  function questionThread(id: string): any {
    return {
      id,
      cursor: '900',
      messages: [
        message({
          id: `${id}-m1`,
          threadId: id,
          from: 'sarah@example.com',
          subject: 'Project launch',
          date: 'Mon, 15 Jan 2024 10:00:00 +0000',
          body: 'Can we move the launch to Tuesday?',
        }),
      ],
    }
  }

  async function storeLlmKey(minImportance: number) {
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)
    const { saveAiSettings } = await import('#/lib/ai/settings.ts')
    await saveAiSettings(USER, {
      jevModel: null,
      llmProvider: 'gemini',
      llmModel: null,
      suggestReplyMinImportance: minImportance,
      llmApiKey: 'llm-secret',
    })
  }

  test('with no LLM key there is nothing to draft with, and nothing is called', async () => {
    const client = new FakeMailboxClient({ threads: [questionThread('q1')] })
    await backfill(client, ACCOUNT, { userId: USER })

    expect(await draftReply(USER, 'q1', null)).toEqual({
      draft: null,
      error: 'No LLM key is configured, so there is nothing to draft with.',
    })
  })

  test('a sender a reply cannot reach is refused even with a key stored', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 'robot-thread',
          cursor: '901',
          messages: [
            message({
              id: 'm1',
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

    await backfill(client, ACCOUNT, { userId: USER })
    await storeLlmKey(1)

    expect(await draftReply(USER, 'robot-thread', null)).toEqual({
      draft: null,
      error: 'There is nobody on this thread a reply can reach.',
    })
  })

  test('a thread below the threshold is left alone and names both numbers', async () => {
    const client = new FakeMailboxClient({ threads: [questionThread('q2')] })
    await backfill(client, ACCOUNT, { userId: USER })
    await storeLlmKey(8)

    // One unanswered message scores importance 4 in the rules, and the threshold
    // this test stored is 8.
    const result = await draftReply(USER, 'q2', null)
    expect(result.draft).toBeNull()
    expect(result.error).toBe('Importance 4/10 — drafts start at 8.')
  })

  test('the detail payload offers the control only where the server would draft', async () => {
    const client = new FakeMailboxClient({ threads: [questionThread('q3')] })
    await backfill(client, ACCOUNT, { userId: USER })

    const { loadConversation } = await import('#/lib/gmail/service.ts')

    // No key: the feature is off, and there is nothing to explain about a thread.
    const before = await loadConversation(USER, 'q3')
    expect(before?.suggestReply.available).toBe(false)
    expect(before?.suggestReply.reason).toBeNull()

    await storeLlmKey(8)
    const gated = await loadConversation(USER, 'q3')
    expect(gated?.suggestReply).toEqual({
      available: false,
      reason: 'Importance 4/10 — drafts start at 8.',
      minImportance: 8,
    })

    // Low enough that this thread qualifies: the view and the action agree.
    await storeLlmKey(1)
    const offered = await loadConversation(USER, 'q3')
    expect(offered?.suggestReply.available).toBe(true)
    expect(offered?.suggestReply.reason).toBeNull()
  })
})

/**
 * Re-classifying mail that is already stored.
 *
 * A classifier change cannot reach a thread incremental sync never revisits, and
 * the alternative — forgetting the mailbox and syncing again — throws away the
 * user's own topics and goals. This is the local pass that closes that gap.
 */
describe('redecideStoredConversations', () => {
  test('re-decides stored mail locally and keeps what the user set', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 'bulk-thread',
          cursor: '900',
          messages: [
            message({
              id: 'm1',
              threadId: 'bulk-thread',
              from: 'news@example.com',
              subject: 'Big sale',
              date: 'Mon, 15 Jan 2024 10:00:00 +0000',
              body: "Big sale this week!\n\nCan't see this email? View it in your browser.",
            }),
          ],
        },
      ],
    })

    await backfill(client, ACCOUNT, { userId: USER })

    // A decision written by the old classifier, plus a topic the user typed.
    await db
      .update(conversations)
      .set({
        state: 'needs-action',
        requiresReply: true,
        topic: 'Sale I care about',
      })
      .where(eq(conversations.providerThreadId, 'bulk-thread'))

    client.calls.length = 0

    const { redecideStoredConversations } =
      await import('#/lib/mailbox/sync.ts')
    const redecided = await redecideStoredConversations(ACCOUNT, USER)

    expect(redecided).toBe(1)
    const [conversation] = await listConversations(ACCOUNT)
    // Bulk mail no longer claims action...
    expect(conversation.state).toBe('low-priority')
    expect(conversation.requiresReply).toBe(false)
    // ...and the user's own topic survives being re-decided.
    expect(conversation.topic).toBe('Sale I care about')
    // Local only: the whole point is that no mail is re-fetched.
    expect(client.calls.some((c) => c.startsWith('getThread'))).toBe(false)
  })
})

/**
 * What the user says about a thread, and what the app learns from it.
 *
 * Classification is a guess about someone else's mail; the user's own answer is
 * not a guess, and it has to outlive everything that recomputes a thread — the
 * next sync, a re-decide, a version bump. The other half is learning: the same
 * sender writes the same kind of notice every time, so filing one away should
 * be enough to stop the next one being filed as work.
 */
describe('the user’s own call on a thread', () => {
  const NOTICE_SENDER = 'notify@shop.example'

  /** A one-off notice: one message, nobody asking the reader anything. */
  function notice(
    threadId: string,
    providerMessageId: string,
    body: string,
    from = NOTICE_SENDER,
  ): any {
    return {
      id: threadId,
      cursor: '900',
      messages: [
        message({
          id: providerMessageId,
          threadId,
          from,
          subject: 'Notice',
          date: 'Mon, 15 Jan 2024 10:00:00 +0000',
          body,
        }),
      ],
    }
  }

  /** A human asking for something, which the rules file as needs-action. */
  function question(threadId: string, body: string): any {
    return {
      id: threadId,
      cursor: '900',
      messages: [
        message({
          id: `${threadId}-m1`,
          threadId,
          from: 'sarah@example.com',
          subject: 'Project',
          date: 'Mon, 15 Jan 2024 10:00:00 +0000',
          body,
        }),
      ],
    }
  }

  test('a thread filed away stays filed away through a sync and a re-decide', async () => {
    const client = new FakeMailboxClient({
      threads: [question('ask-thread', 'Can you confirm Tuesday?')],
    })
    await backfill(client, ACCOUNT, { userId: USER })

    const { applyUserStateOverride } = await import('#/lib/gmail/service.ts')
    await applyUserStateOverride(USER, 'ask-thread', 'low-priority')

    const filed = await listConversations(ACCOUNT)
    expect(filed[0].state).toBe('low-priority')
    // Stored as well as applied: the row is what a later rebuild has to read.
    expect(filed[0].stateOverride?.state).toBe('low-priority')

    // A later sync rebuilds the thread from Gmail and knows nothing about the
    // user's call, so this is where it would be lost.
    await backfill(client, ACCOUNT, { userId: USER })
    expect((await listConversations(ACCOUNT))[0].state).toBe('low-priority')

    // The same argument for the local pass a version bump runs.
    const { redecideStoredConversations } =
      await import('#/lib/mailbox/sync.ts')
    await redecideStoredConversations(ACCOUNT, USER)
    expect((await listConversations(ACCOUNT))[0].state).toBe('low-priority')
  })

  test('a new message re-opens a thread the user filed away', async () => {
    const client = new FakeMailboxClient({
      threads: [question('ask-thread', 'Can you confirm Tuesday?')],
    })
    await backfill(client, ACCOUNT, { userId: USER })

    const { applyUserStateOverride } = await import('#/lib/gmail/service.ts')
    await applyUserStateOverride(USER, 'ask-thread', 'low-priority')

    // The call was a judgement about the mail that existed when it was made, so
    // a later message deserves a fresh look rather than inheriting it.
    client.setThread({
      id: 'ask-thread',
      cursor: '901',
      messages: [
        ...question('ask-thread', 'Can you confirm Tuesday?').messages,
        message({
          id: 'ask-thread-m2',
          threadId: 'ask-thread',
          from: 'sarah@example.com',
          subject: 'Re: Project',
          date: 'Wed, 17 Jan 2024 10:00:00 +0000',
          body: 'Can you send the new figures?',
        }),
      ],
    })
    await backfill(client, ACCOUNT, { userId: USER })

    const reopened = (await listConversations(ACCOUNT))[0]
    expect(reopened.state).toBe('needs-action')
    // The expired call is dropped rather than left looking current.
    expect(reopened.stateOverride).toBeNull()
  })

  test('filing a notice away ranks the next one from that sender low, until one is brought back', async () => {
    const client = new FakeMailboxClient({
      threads: [
        notice('notice-1', 'm1', 'Your order has shipped.'),
        notice('notice-2', 'm2', 'A new device signed in.'),
      ],
    })
    await backfill(client, ACCOUNT, { userId: USER })

    // Neither asks for anything, and neither is machine-marked, so both are
    // informational until the user says otherwise.
    const before = await listConversations(ACCOUNT)
    expect(before.every((c) => c.state === 'informational')).toBe(true)

    const { applyUserStateOverride } = await import('#/lib/gmail/service.ts')
    await applyUserStateOverride(USER, 'notice-1', 'low-priority')

    const filed = await listConversations(ACCOUNT)
    expect(filed.find((c) => c.providerThreadId === 'notice-1')?.state).toBe(
      'low-priority',
    )

    // The sender is learned now, so the next notice is ranked low on sight —
    // one dismissal covering the same mail every time it arrives.
    client.setThread(notice('notice-3', 'm3', 'Your subscription renews soon.'))
    await backfill(client, ACCOUNT, { userId: USER })

    const learned = await listConversations(ACCOUNT)
    expect(learned.find((c) => c.providerThreadId === 'notice-3')?.state).toBe(
      'low-priority',
    )

    // The local re-decide a version bump runs applies the same lesson to mail
    // already stored, rather than only to what arrives next.
    const { redecideStoredConversations } =
      await import('#/lib/mailbox/sync.ts')
    await redecideStoredConversations(ACCOUNT, USER)
    expect(
      (await listConversations(ACCOUNT)).find(
        (c) => c.providerThreadId === 'notice-2',
      )?.state,
    ).toBe('low-priority')

    // Bringing one back says the assumption was wrong for this sender, so the
    // rest stop being ranked low too — the alternative (a net count) would
    // leave the button doing nothing for a sender filed away more than once.
    await applyUserStateOverride(USER, 'notice-1', null)
    await redecideStoredConversations(ACCOUNT, USER)

    const restored = await listConversations(ACCOUNT)
    expect(restored.find((c) => c.providerThreadId === 'notice-1')?.state).toBe(
      'informational',
    )
    expect(restored.find((c) => c.providerThreadId === 'notice-2')?.state).toBe(
      'informational',
    )
    expect(
      restored.find((c) => c.providerThreadId === 'notice-1')?.stateOverride,
    ).toBeNull()
  })

  test('labelling a thread is a call about the thread, not the sender', async () => {
    // Any of the four labels can be set now, and only "Low priority" says
    // anything about the sender. The bug this guards: the sender lesson used to
    // be recorded for whatever the button sent, so relabelling one thread
    // "Needs action" would quietly start ranking every other notice from that
    // sender low — the opposite of what the label just said.
    const client = new FakeMailboxClient({
      threads: [
        notice('notice-1', 'm1', 'Your order has shipped.'),
        notice('notice-2', 'm2', 'A new device signed in.'),
      ],
    })
    await backfill(client, ACCOUNT, { userId: USER })

    const { applyUserStateOverride } = await import('#/lib/gmail/service.ts')
    await applyUserStateOverride(USER, 'notice-1', 'needs-action')

    const labelled = await listConversations(ACCOUNT)
    const one = labelled.find((c) => c.providerThreadId === 'notice-1')
    expect(one?.state).toBe('needs-action')
    // Stored, not just applied: a rebuild reads the row.
    expect(one?.stateOverride?.state).toBe('needs-action')

    // The other thread from the same sender is untouched, and the next one to
    // arrive is filed on its own merits.
    expect(labelled.find((c) => c.providerThreadId === 'notice-2')?.state).toBe(
      'informational',
    )
    client.setThread(notice('notice-3', 'm3', 'Your subscription renews soon.'))
    await backfill(client, ACCOUNT, { userId: USER })
    expect(
      (await listConversations(ACCOUNT)).find(
        (c) => c.providerThreadId === 'notice-3',
      )?.state,
    ).toBe('informational')

    // And it survives the local pass a version bump runs, which is where a label
    // the decision layer disagrees with would be recomputed away.
    const { redecideStoredConversations } =
      await import('#/lib/mailbox/sync.ts')
    await redecideStoredConversations(ACCOUNT, USER)
    const after = (await listConversations(ACCOUNT)).find(
      (c) => c.providerThreadId === 'notice-1',
    )
    expect(after?.state).toBe('needs-action')
    expect(after?.stateOverride?.state).toBe('needs-action')

    // The picker's "Automatic": the stored label goes and the app's own answer
    // stands again.
    await applyUserStateOverride(USER, 'notice-1', null)
    const handedBack = (await listConversations(ACCOUNT)).find(
      (c) => c.providerThreadId === 'notice-1',
    )
    expect(handedBack?.state).toBe('informational')
    expect(handedBack?.stateOverride).toBeNull()
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
    const { buildConversation, saveConversation } =
      await import('#/lib/conversation/index.ts')
    await db.insert(accounts).values({
      id: OTHER,
      userId: USER,
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
        providerThreadId: 'complete-thread',
      }),
    )

    // ...and two single-message fragments in the other, for the same messages.
    await saveConversation(
      OTHER,
      buildConversation([m1], {
        ownerEmail: OTHER,
        providerThreadId: 'fragment-one',
      }),
    )
    await saveConversation(
      OTHER,
      buildConversation([m2], {
        ownerEmail: OTHER,
        providerThreadId: 'fragment-two',
      }),
    )

    const { loadConversation } = await import('#/lib/gmail/service.ts')

    // Loading the *fragment* must still show the whole conversation.
    const detail = await loadConversation(USER, 'fragment-one')
    expect(detail).not.toBeNull()
    // The DTO does not expose Message-IDs; the bodies identify both messages.
    expect(detail?.messages.map((m) => m.body)).toEqual(['First.', 'Second.'])
    // The canonical row is the owner's most complete copy, not the fragment.
    expect(detail?.providerThreadId).toBe('complete-thread')
    expect(detail?.accountId).toBe(ACCOUNT)
    expect(detail?.ownerEmails).toEqual([ACCOUNT, OTHER])

    // Both ways into the cluster resolve to the same conversation.
    const fromComplete = await loadConversation(USER, 'complete-thread')
    expect(fromComplete?.messages.map((m) => m.body)).toEqual([
      'First.',
      'Second.',
    ])
    expect(fromComplete?.providerThreadId).toBe('complete-thread')
  })
})

describe('backfill', () => {
  test('persists conversations for every thread', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '900',
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
          cursor: '901',
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

    const result = await backfill(client, ACCOUNT, { userId: USER })

    expect(result.synced).toBe(2)
    expect(result.skipped).toBe(0)

    const stored = await listConversations(ACCOUNT)
    expect(stored).toHaveLength(2)
  })

  test('cleans bodies and derives state from the message flow', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '900',
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

    await backfill(client, ACCOUNT, { userId: USER })
    const [conversation] = await listConversations(ACCOUNT)

    expect(conversation.subject).toBe('Project launch')
    expect(conversation.messages[0].body).toBe(
      'Can we move the launch to Tuesday?',
    )
    expect(conversation.messages[0].greeting).toBe('Hi Alex,')
    expect(conversation.state).toBe('needs-action')
  })

  test('excludes drafts and trashed messages', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '900',
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

    await backfill(client, ACCOUNT, { userId: USER })
    const [conversation] = await listConversations(ACCOUNT)

    expect(conversation.messageCount).toBe(1)
    expect(conversation.messages[0].body).toBe('Actual message.')
  })

  test('skips a thread with no relevant messages', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '900',
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

    const result = await backfill(client, ACCOUNT, { userId: USER })
    expect(result.synced).toBe(0)
    expect(result.skipped).toBe(1)
  })

  test('paginates through thread listings', async () => {
    const threads = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`,
      cursor: '900',
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

    const client = new FakeMailboxClient({ threads, pageSize: 2 })

    const result = await backfill(client, ACCOUNT, { userId: USER })

    expect(result.synced).toBe(5)
    // 5 threads at 2 per page = 3 listing calls.
    const listCalls = client.calls.filter((c) => c.startsWith('listThreads'))
    expect(listCalls).toHaveLength(3)
  })

  test('respects the limit and stops paginating early', async () => {
    const threads = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      cursor: '900',
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

    const client = new FakeMailboxClient({ threads, pageSize: 2 })
    const result = await backfill(client, ACCOUNT, { userId: USER, limit: 3 })

    expect(result.synced).toBe(3)
  })

  test('announces the total once the listing is done', async () => {
    // The count is only known after `threads.list` finishes paging, which is why
    // it is a separate event from `start` — the progress banner has no
    // denominator until this arrives, and a first backfill is all listing.
    const threads = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`,
      cursor: '900',
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

    const events: SyncEvent[] = []
    await backfill(new FakeMailboxClient({ threads, pageSize: 2 }), ACCOUNT, {
      userId: USER,
      onProgress: (event) => events.push(event),
    })

    expect(events.filter((e) => e.type === 'listed')).toEqual([
      { type: 'listed', total: 5 },
    ])

    // Every thread the listing named is accounted for, so a bar built from these
    // numbers cannot stall short of its total.
    const finished = events.filter(
      (e) => e.type === 'thread' || e.type === 'skipped' || e.type === 'error',
    )
    expect(finished).toHaveLength(5)

    expect(events.at(-1)?.type).toBe('done')
  })

  test('one failing thread does not abort the whole sync', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 'good',
          cursor: '900',
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
          cursor: '900',
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
      userId: USER,
      onProgress: (e) => {
        if (e.type === 'error') errors.push(e.threadId)
      },
    })

    expect(result.synced).toBe(1)
    expect(result.skipped).toBe(1)
    expect(errors).toContain('bad')

    const stored = await listConversations(ACCOUNT)
    expect(stored.map((c) => c.providerThreadId)).toEqual(['good'])
  })

  test('stores attachment metadata without downloading bytes', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '900',
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

    await backfill(client, ACCOUNT, { userId: USER })
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
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '900',
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

    const result = await backfill(client, ACCOUNT, { userId: USER })
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
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '900',
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

    await backfill(client, ACCOUNT, { userId: USER })

    const loaded = await getConversation(ACCOUNT, 't1')
    expect(loaded?.attachments).toHaveLength(1)

    // The chat view matches a chip to its bubble through this value.
    const attachmentMessageId = loaded?.attachments[0]?.providerMessageId
    expect(loaded?.messages.map((m) => m.providerMessageId)).toContain(
      attachmentMessageId,
    )

    await expect(saveConversation(ACCOUNT, loaded!)).resolves.toBeUndefined()
  })

  test('a reply keeps the thread attachments it rebuilds', async () => {
    // Sending re-reads one thread and saves it again. The rebuild supplied no
    // attachment metadata, so the conversation claimed to have none — and since
    // saving replaces the messages wholesale, the attachment rows were
    // cascade-deleted and none were written back. Every chip vanished from the
    // thread the user had just replied to, until some later sync restored them.
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '900',
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

    await backfill(client, ACCOUNT, { userId: USER })
    expect((await getConversation(ACCOUNT, 't1'))?.attachments).toHaveLength(1)

    await refreshThread(client, ACCOUNT, 't1')

    const afterReply = await getConversation(ACCOUNT, 't1')
    expect(afterReply?.attachments).toHaveLength(1)
    expect(afterReply?.attachments[0]?.filename).toBe('q1.pdf')
    expect(afterReply?.attachmentCount).toBe(1)

    // Still addressable: a chip is matched to its bubble through this value.
    expect(afterReply?.messages.map((m) => m.providerMessageId)).toContain(
      afterReply?.attachments[0]?.providerMessageId,
    )
  })

  test('records a decision for every synced conversation', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '900',
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

    await backfill(client, ACCOUNT, { userId: USER })

    // The seam is now actually invoked by sync, not just defined.
    const rows = await db.select().from(decisions)
    expect(rows).toHaveLength(1)
    expect(rows[0].provider).toBe('rules+rules+none')
    expect(rows[0].state).toBe('needs-action')
    expect(rows[0].reasoning).toBeTruthy()
  })

  test('advances the history cursor', async () => {
    const client = new FakeMailboxClient({
      threads: [],
      cursor: '55555',
    })

    const result = await backfill(client, ACCOUNT, { userId: USER })
    expect(result.cursor).toBe('55555')
    expect(client.calls).toContain('getProfileHistoryId')
  })
})

describe('syncIncremental', () => {
  test('refetches only threads that changed', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '910',
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
          cursor: '1001',
        },
      },
    })

    const result = await syncIncremental(client, ACCOUNT, '1000', {
      userId: USER,
    })

    expect(result.synced).toBe(1)
    const threadFetches = client.calls.filter((c) => c.startsWith('getThread'))
    expect(threadFetches).toEqual(['getThread:t1'])
  })

  test('dedupes thread ids across history records', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '910',
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
          cursor: '1002',
        },
      },
    })

    await syncIncremental(client, ACCOUNT, '1000', { userId: USER })

    const threadFetches = client.calls.filter((c) => c.startsWith('getThread'))
    expect(threadFetches).toHaveLength(1)
  })

  test('throws when the cursor has expired', async () => {
    const client = new FakeMailboxClient({ threads: [] })
    await expect(
      syncIncremental(client, ACCOUNT, 'stale', { userId: USER }),
    ).rejects.toThrow(/no longer available/i)
  })
})

describe('sync', () => {
  test('falls back to backfill when the cursor is stale', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '910',
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

    const result = await sync(client, ACCOUNT, {
      userId: USER,
      startHistoryId: 'stale',
    })

    expect(result.synced).toBe(1)
    const stored = await listConversations(ACCOUNT)
    expect(stored).toHaveLength(1)
  })

  test('uses incremental when a cursor exists', async () => {
    const client = new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '910',
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
          cursor: '1001',
        },
      },
    })

    const result = await sync(client, ACCOUNT, {
      userId: USER,
      startHistoryId: '1000',
    })

    expect(result.synced).toBe(1)
    expect(client.calls.some((c) => c.startsWith('listThreads'))).toBe(false)
  })
})

describe('AI settings', () => {
  test('stores keys encrypted and builds the pipeline config without leaking them', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)
    const { getAiPipelineConfig, getAiSettings, saveAiSettings } =
      await import('#/lib/ai/settings.ts')

    await saveAiSettings(USER, {
      jevModel: 'jev-latest',
      llmProvider: 'gemini',
      llmModel: null,
      suggestReplyMinImportance: 6,
      jevApiKey: 'jev-secret',
      llmApiKey: 'llm-secret',
    })

    const summary = await getAiSettings(USER)
    expect(summary.jevConfigured).toBe(true)
    expect(summary.llmProvider).toBe('gemini')
    expect(summary.llmConfigured).toBe(true)
    // The summary shown to the browser never contains a secret.
    expect(JSON.stringify(summary)).not.toContain('jev-secret')
    expect(JSON.stringify(summary)).not.toContain('llm-secret')

    const config = await getAiPipelineConfig(USER)
    expect(config.jev).toEqual({ apiKey: 'jev-secret', model: 'jev-latest' })
    expect(config.llm).toEqual({
      provider: 'gemini',
      apiKey: 'llm-secret',
      model: 'gemini-2.5-flash',
    })
  })

  test('leaves a key unchanged when omitted and clears it when emptied', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)
    const { getAiPipelineConfig, getAiSettings, saveAiSettings } =
      await import('#/lib/ai/settings.ts')

    await saveAiSettings(USER, {
      jevModel: null,
      llmProvider: null,
      llmModel: null,
      suggestReplyMinImportance: 6,
      jevApiKey: 'first',
    })
    expect((await getAiPipelineConfig(USER)).jev?.apiKey).toBe('first')

    // Omitting the key leaves it as-is.
    await saveAiSettings(USER, {
      jevModel: null,
      llmProvider: null,
      llmModel: null,
      suggestReplyMinImportance: 6,
    })
    expect((await getAiPipelineConfig(USER)).jev?.apiKey).toBe('first')

    // An empty string clears it.
    await saveAiSettings(USER, {
      jevModel: null,
      llmProvider: null,
      llmModel: null,
      suggestReplyMinImportance: 6,
      jevApiKey: '',
    })
    expect((await getAiPipelineConfig(USER)).jev).toBeNull()
    expect((await getAiSettings(USER)).jevConfigured).toBe(false)
  })

  test('the draft threshold round-trips, and a bad one is clamped rather than obeyed', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)
    const { getAiSettings, saveAiSettings } =
      await import('#/lib/ai/settings.ts')

    const base = {
      jevModel: null,
      llmProvider: null,
      llmModel: null,
      jevApiKey: null,
      llmApiKey: null,
    }

    await saveAiSettings(USER, { ...base, suggestReplyMinImportance: 3 })
    expect((await getAiSettings(USER)).suggestReplyMinImportance).toBe(3)

    // Out of range is not stored as given: the score it compares against is 1–10,
    // so 0 (every thread eligible) and 99 (none) both have to be brought back in.
    await saveAiSettings(USER, { ...base, suggestReplyMinImportance: 0 })
    expect((await getAiSettings(USER)).suggestReplyMinImportance).toBe(1)

    await saveAiSettings(USER, { ...base, suggestReplyMinImportance: 99 })
    expect((await getAiSettings(USER)).suggestReplyMinImportance).toBe(10)
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

/**
 * Attachments are fetched on demand — sync records metadata only — so this is
 * the only place the download-and-cache path runs. Nothing else covers it: the
 * cache helpers existed unused until a chip became clickable.
 */
describe('loadAttachment', () => {
  const ATTACHMENT_BYTES = Buffer.from('the bytes of q1.pdf')

  function clientWithAttachment(args: { size: number }) {
    return new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '900',
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
                    size: args.size,
                  },
                }),
              ),
            },
          ],
        },
      ],
      attachments: {
        'att-1': {
          data: ATTACHMENT_BYTES.toString('base64'),
          size: ATTACHMENT_BYTES.byteLength,
        },
      },
    })
  }

  /** Point the cache at a temp dir, and hand back the previous value. */
  function useTempCache(): string | undefined {
    const previous = process.env.ATTACHMENT_CACHE_DIR
    process.env.ATTACHMENT_CACHE_DIR = join(tmpDir, 'attachments')
    return previous
  }

  test('downloads the bytes for a stored attachment and caches them', async () => {
    const previous = useTempCache()
    const client = clientWithAttachment({ size: 4096 })

    try {
      await backfill(client, ACCOUNT, { userId: USER })

      const result = await loadAttachment(USER, 't1', 'att-1', { client })
      if (!result.ok) throw new Error(`expected bytes, got ${result.reason}`)

      expect(result.file.filename).toBe('q1.pdf')
      expect(result.file.mimeType).toBe('application/pdf')
      expect(result.file.bytes.toString('utf-8')).toBe(
        ATTACHMENT_BYTES.toString('utf-8'),
      )

      // The download is recorded, so the next open does not go to Gmail again.
      const stored = await getStoredAttachment(USER, 't1', 'att-1')
      expect(stored?.localPath).toBeTruthy()

      const second = await loadAttachment(USER, 't1', 'att-1', { client })
      expect(second.ok).toBe(true)
      expect(
        client.calls.filter((call) => call.startsWith('getAttachment')),
      ).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.ATTACHMENT_CACHE_DIR
      else process.env.ATTACHMENT_CACHE_DIR = previous
    }
  })

  test('reports an oversized attachment instead of fetching it', async () => {
    const previous = useTempCache()
    const tooLarge = MAX_ATTACHMENT_BYTES + 1
    const client = clientWithAttachment({ size: tooLarge })

    try {
      await backfill(client, ACCOUNT, { userId: USER })

      const result = await loadAttachment(USER, 't1', 'att-1', { client })

      expect(result).toEqual({ ok: false, reason: 'too-large' })
      expect(client.calls.some((c) => c.startsWith('getAttachment'))).toBe(
        false,
      )
    } finally {
      if (previous === undefined) delete process.env.ATTACHMENT_CACHE_DIR
      else process.env.ATTACHMENT_CACHE_DIR = previous
    }
  })

  test('reports an unknown attachment rather than throwing', async () => {
    const result = await loadAttachment(USER, 't1', 'no-such-attachment')

    expect(result).toEqual({ ok: false, reason: 'not-found' })
  })
})

/**
 * Starting over.
 *
 * A library synced by an older version keeps that version's parsing, because the
 * fixes apply when a message is parsed rather than to rows already written. These
 * are the checks behind the "delete stored mail" action that makes a fresh sync
 * possible.
 */
describe('forgetAccount', () => {
  /** Run `fn` with the attachment cache pointed at a temp directory. */
  async function withTempCache(fn: (cache: string) => Promise<void>) {
    const previous = process.env.ATTACHMENT_CACHE_DIR
    const cache = join(tmpDir, `cache-${Math.random().toString(36).slice(2)}`)
    process.env.ATTACHMENT_CACHE_DIR = cache

    try {
      await mkdir(cache, { recursive: true })
      await fn(cache)
    } finally {
      if (previous === undefined) delete process.env.ATTACHMENT_CACHE_DIR
      else process.env.ATTACHMENT_CACHE_DIR = previous
    }
  }

  function clientWithSavedThread() {
    return new FakeMailboxClient({
      threads: [
        {
          id: 't1',
          cursor: '900',
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
  }

  test('deletes the mailbox, its stored mail, and only its cached files', async () => {
    await withTempCache(async (cache) => {
      await backfill(clientWithSavedThread(), ACCOUNT, { userId: USER })
      expect(await listConversations(ACCOUNT)).toHaveLength(1)

      const mine = join(cache, ACCOUNT, 'a1b2', 'q1.pdf')
      const other = join(cache, 'someone@example.com', 'a1b2', 'q1.pdf')
      for (const file of [mine, other]) {
        await mkdir(join(file, '..'), { recursive: true })
        await writeFile(file, 'bytes')
      }

      await forgetAccount(USER, ACCOUNT)

      expect(await listConversations(ACCOUNT)).toHaveLength(0)
      expect(
        await db
          .select()
          .from(attachmentsTable)
          .where(eq(attachmentsTable.conversationId, `${ACCOUNT}:t1`)),
      ).toHaveLength(0)
      expect(await db.select().from(accounts)).toHaveLength(0)

      // The cached files go with the rows; another mailbox's stay.
      expect(existsSync(mine)).toBe(false)
      expect(existsSync(other)).toBe(true)
    })
  })

  test('a crafted account id cannot reach outside the cache', async () => {
    await withTempCache(async () => {
      const outside = join(tmpDir, 'outside-the-cache')
      await mkdir(outside, { recursive: true })
      const kept = join(outside, 'keep.txt')
      await writeFile(kept, 'keep')

      await removeAttachmentCache('../outside-the-cache')

      expect(existsSync(kept)).toBe(true)
    })
  })
})

describe('loadInbox on a mailbox that has never synced', () => {
  // The stored envelope is deliberately bogus, so `createMailboxClient` fails on
  // the decryption rather than the network — this exercises the branch without
  // ever reaching Gmail.
  test('starts the first sync without waiting for it, then reports its failure', async () => {
    const started = await loadInbox(USER)
    if (!started.signedIn) throw new Error('expected a signed-in payload')

    // The load took the background branch and returned while the run was still
    // going. Awaiting it in line would have failed first and come back with the
    // error already set, which is the behaviour this replaced.
    expect(started.syncedNow).toBe(true)
    expect(started.syncError).toBeNull()

    // The run is fire-and-forget, so poll until it settles rather than racing it —
    // this account fails instantly, so progress may be gone before the first
    // response is built. What matters is that a later load explains the still-empty
    // inbox instead of showing a spinner nobody can clear.
    let settledError: string | null = null
    let settledAuth: string[] = []
    let settledSyncing = -1
    for (let attempt = 0; attempt < 200 && settledError === null; attempt++) {
      await Bun.sleep(10)
      const next = await loadInbox(USER)
      if (next.signedIn && next.syncError) {
        settledError = next.syncError
        settledAuth = next.authRequiredAccounts.map((a) => a.id)
        settledSyncing = next.syncing.length
      }
    }

    expect(settledError).toContain('could not be decrypted')
    expect(settledAuth).toEqual([ACCOUNT])
    // Nothing is running any more, and the progress entry went with the run.
    expect(settledSyncing).toBe(0)

    // And the failure does not restart a run on every load: a retry that began
    // immediately would overwrite the error before it could ever be rendered.
    const reloaded = await loadInbox(USER)
    if (!reloaded.signedIn) throw new Error('expected a signed-in payload')
    expect(reloaded.syncedNow).toBe(false)
    expect(reloaded.syncError).toContain('could not be decrypted')

    // Re-sync is the escape hatch. A forced load starts a fresh attempt instead of
    // re-reporting the failure it exists to clear — otherwise the mailbox the
    // banner is complaining about could never be recovered from the UI.
    const forced = await loadInbox(USER, { force: true, full: true })
    if (!forced.signedIn) throw new Error('expected a signed-in payload')
    expect(forced.syncedNow).toBe(true)
    expect(forced.syncError).toBeNull()
  })
})

/**
 * What a signed-in user may reach.
 *
 * Every service entry point is scoped by the session's user id, and the ids that
 * arrive in a request — a thread id, an attachment id, a mailbox — are checked
 * rather than trusted. This is the test that fails if any of that is dropped.
 */
describe('one user’s mail is another’s', () => {
  const OTHER_USER = 'someone-else@example.com'

  test('an inbox, a thread, an attachment and a deletion are all scoped to the owner', async () => {
    // One stored thread with one attachment, so every id the other user could
    // name really does exist — under somebody else's owner.
    await backfill(
      new FakeMailboxClient({
        threads: [
          {
            id: 't1',
            cursor: '900',
            messages: [
              {
                id: 'm1',
                threadId: 't1',
                labelIds: ['INBOX'],
                internalDate: '1705312800000',
                snippet: '',
                payload: normalizePart(
                  multipartPayload({
                    headers: { from: 's@e.com', subject: 'Report' },
                    text: 'See attached.',
                    attachment: {
                      filename: 'q1.pdf',
                      mimeType: 'application/pdf',
                      attachmentId: 'att-1',
                      size: 1024,
                    },
                  }),
                ),
              },
            ],
          },
        ],
      }),
      ACCOUNT,
      { userId: USER },
    )
    await db.insert(users).values({
      id: OTHER_USER,
      email: OTHER_USER,
      passwordHash: 'not-a-real-hash',
    })

    // The other user's own mailboxes: none. Their inbox is empty rather than
    // showing the first user's account.
    const inbox = await loadInbox(OTHER_USER)
    if (!inbox.signedIn) throw new Error('expected a signed-in payload')
    expect(inbox.accounts).toEqual([])
    expect(inbox.conversations).toEqual([])

    // A thread id that exists — but belongs to somebody else.
    const { loadConversation } = await import('#/lib/gmail/service.ts')
    expect(await loadConversation(OTHER_USER, 't1')).toBeNull()

    // And an attachment id, which travels in a URL and is therefore the most
    // tempting thing to trust.
    const attachment = await loadAttachment(OTHER_USER, 't1', 'att-1')
    expect(attachment).toEqual({ ok: false, reason: 'not-found' })

    // Deleting a mailbox by id is refused rather than performed.
    await expect(forgetAccount(OTHER_USER, ACCOUNT)).rejects.toThrow(
      /not connected to this account/i,
    )
    expect((await listConversations(ACCOUNT)).length).toBeGreaterThan(0)

    // The owner still sees all of it.
    expect(await loadConversation(USER, 't1')).not.toBeNull()
  })
})
