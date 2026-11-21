import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Saving a spam rule has to reach the mail already in the inbox, not just the
 * next delivery. These tests drive the same service the settings action calls,
 * against a real (temporary) database.
 */

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-spam-refile-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const { accounts, spamSenderSignals, spamRules, users } =
  await import('#/db/schema.ts')
const {
  buildConversation,
  getConversation,
  getConversationClusterByThreadId,
  saveConversation,
} = await import('#/lib/conversation/index.ts')
const { saveSpamRules } = await import('./repository.ts')
const { refileStoredSpamMatches } = await import('#/lib/gmail/service.ts')

await initDatabase()

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

const USER = 'alice@example.com'
const ACCOUNT = 'alice@example.com'

beforeEach(async () => {
  await db.delete(spamSenderSignals)
  await db.delete(spamRules)
  await db.delete(accounts)
  await db.delete(users)
  await db.insert(users).values({
    id: USER,
    email: USER,
    passwordHash: '$argon2id$v=19$m=1$s$h',
  })
  await db.insert(accounts).values({
    id: ACCOUNT,
    email: ACCOUNT,
    userId: USER,
    refreshTokenEncrypted: 'not-a-real-token',
  })
})

/** A parsed message with only the fields the conversation builder needs. */
function message(args: {
  from: string
  subject: string
  messageId: string
  inReplyTo?: string
  references?: string[]
  to?: string[]
}) {
  return {
    subject: args.subject,
    from: args.from,
    to: args.to ?? [ACCOUNT],
    cc: [],
    date: new Date('2024-01-15T10:00:00Z'),
    messageId: args.messageId,
    inReplyTo: args.inReplyTo,
    references: args.references,
    parts: [{ contentType: 'text/plain', text: 'Body.' }],
  }
}

async function store(
  providerThreadId: string,
  args: { from: string; subject: string; messageId?: string; to?: string[] },
  accountId = ACCOUNT,
) {
  await saveConversation(
    accountId,
    buildConversation(
      [
        message({
          from: args.from,
          subject: args.subject,
          messageId: args.messageId ?? `<${providerThreadId}@example.com>`,
          to: args.to,
        }),
      ],
      { ownerEmail: accountId, providerThreadId },
    ),
  )
}

describe('refiling stored mail after a rule change', () => {
  test('moves inbox mail matched by a sender or subject rule to spam', async () => {
    await store('sender-rule', {
      from: 'deals@example.com',
      subject: 'Hello',
    })
    await store('subject-rule', {
      from: 'friend@example.com',
      subject: 'Weekly lottery results',
    })
    await store('unmatched', {
      from: 'friend@example.com',
      subject: 'Lunch on Friday?',
    })

    await saveSpamRules(USER, [
      { field: 'sender-email', value: 'deals@example.com' },
      { field: 'subject-contains', value: 'lottery' },
    ])

    expect(await refileStoredSpamMatches(USER)).toBe(2)

    expect((await getConversation(ACCOUNT, 'sender-rule'))?.folder).toBe('spam')
    expect((await getConversation(ACCOUNT, 'subject-rule'))?.folder).toBe(
      'spam',
    )
    expect((await getConversation(ACCOUNT, 'unmatched'))?.folder).toBe('inbox')
  })

  test('opens the copies that were matched without a shared Message-ID', async () => {
    const other = 'bob@example.com'
    await db.insert(accounts).values({
      id: other,
      email: other,
      userId: USER,
      refreshTokenEncrypted: 'not-a-real-token',
    })

    // Two providers' own ids instead of an RFC Message-ID: the exact walk finds
    // nothing, so the identity fallback is the only thing that can see these are
    // the same conversation.
    await store('a-thread', {
      from: 'deals@example.com',
      subject: 'Invoice',
      messageId: 'graph-a',
    })
    await store(
      'b-thread',
      {
        from: 'deals@example.com',
        subject: 'Re: Invoice',
        messageId: 'graph-b',
      },
      other,
    )

    const cluster = await getConversationClusterByThreadId(USER, 'a-thread')
    expect(cluster?.map((entry) => entry.accountId).sort()).toEqual(
      [ACCOUNT, other].sort(),
    )
  })

  test('opens a reply that the provider split into its own thread', async () => {
    // The case from the inbox: we sent one mail to two people, one replied, and
    // the reply arrived under a different provider thread id. The only link is
    // the reply header pointing at the sent message.
    await saveConversation(
      ACCOUNT,
      buildConversation(
        [
          message({
            from: ACCOUNT,
            subject: 'Quarterly plan',
            messageId: 'sent@example.com',
          }),
        ],
        { ownerEmail: ACCOUNT, providerThreadId: 'sent-thread' },
      ),
    )
    await saveConversation(
      ACCOUNT,
      buildConversation(
        [
          message({
            from: 'bob@example.com',
            subject: 'Re: Quarterly plan',
            messageId: 'reply@example.com',
            inReplyTo: 'sent@example.com',
          }),
        ],
        { ownerEmail: ACCOUNT, providerThreadId: 'reply-thread' },
      ),
    )

    const cluster = await getConversationClusterByThreadId(USER, 'reply-thread')

    expect(
      cluster?.map((entry) => entry.conversation.providerThreadId).sort(),
    ).toEqual(['reply-thread', 'sent-thread'])
  })

  test('opens a stored reply that has no reply headers at all', async () => {
    // Mail synced before the header columns existed still has to open as one
    // conversation: the parent was addressed to Bob, and Bob's later message has
    // the same subject with a Re: prefix.
    await store('sent-thread', {
      from: ACCOUNT,
      to: ['bob@example.com'],
      subject: 'Quarterly plan',
      messageId: 'sent@example.com',
    })
    await store('reply-thread', {
      from: 'bob@example.com',
      subject: 'Re: Quarterly plan',
      messageId: 'reply@example.com',
    })

    const cluster = await getConversationClusterByThreadId(USER, 'sent-thread')

    expect(
      cluster?.map((entry) => entry.conversation.providerThreadId).sort(),
    ).toEqual(['reply-thread', 'sent-thread'])
  })

  test('follows a References-only reply back to its parent', async () => {
    await saveConversation(
      ACCOUNT,
      buildConversation(
        [
          message({
            from: ACCOUNT,
            subject: 'Quarterly plan',
            messageId: 'sent@example.com',
          }),
        ],
        { ownerEmail: ACCOUNT, providerThreadId: 'sent-thread' },
      ),
    )
    await saveConversation(
      ACCOUNT,
      buildConversation(
        [
          message({
            from: 'bob@example.com',
            subject: 'Re: Quarterly plan',
            messageId: 'reply@example.com',
            references: ['sent@example.com'],
          }),
        ],
        { ownerEmail: ACCOUNT, providerThreadId: 'reply-thread' },
      ),
    )

    const cluster = await getConversationClusterByThreadId(USER, 'reply-thread')

    expect(
      cluster?.map((entry) => entry.conversation.providerThreadId).sort(),
    ).toEqual(['reply-thread', 'sent-thread'])
  })

  test('removing a rule does not pull already-filed mail back out of spam', async () => {
    await store('filed', {
      from: 'deals@example.com',
      subject: 'Hello',
    })

    await saveSpamRules(USER, [
      { field: 'sender-email', value: 'deals@example.com' },
    ])
    expect(await refileStoredSpamMatches(USER)).toBe(1)

    // The removal is a statement about future mail. The app cannot tell its own
    // filing from Gmail's, so un-filing here would undo the provider's decision
    // too; moving the thread to the inbox is the deliberate correction.
    await saveSpamRules(USER, [])
    expect(await refileStoredSpamMatches(USER)).toBe(0)
    expect((await getConversation(ACCOUNT, 'filed'))?.folder).toBe('spam')
  })
})
