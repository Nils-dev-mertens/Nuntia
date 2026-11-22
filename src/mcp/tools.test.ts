import { beforeEach, describe, expect, test } from 'bun:test'

const { db, initDatabase } = await import('#/db/index.ts')
const {
  accounts,
  contactContexts,
  contactTags,
  conversations,
  messages,
  sessions,
  users,
} = await import('#/db/schema.ts')
const {
  getPerson,
  getThread,
  listThreads,
  moveThread,
  searchMail,
  sendReplyConfirmed,
  updatePersonNotes,
  updatePersonTags,
} = await import('./tools.ts')

await initDatabase()

const OWNER = 'mcp-owner@example.com'
const ACCOUNT = 'mcp-me@example.com'
const PRIYA = { name: 'Priya', email: 'priya@acme.example' }
const NEWS = { name: null, email: 'news@list.example' }

const NOW = new Date('2026-11-20T10:00:00Z')

function conversation(
  providerThreadId: string,
  overrides: Partial<typeof conversations.$inferInsert> = {},
) {
  return {
    id: `${ACCOUNT}:${providerThreadId}`,
    accountId: ACCOUNT,
    providerThreadId,
    subject: `Subject ${providerThreadId}`,
    participants: [PRIYA],
    state: 'needs-action' as const,
    folder: 'inbox' as const,
    lastMessageAt: NOW,
    messageCount: 1,
    ...overrides,
  }
}

function message(
  providerMessageId: string,
  conversationId: string,
  from = PRIYA,
  bodyText = 'The NDA for Project X is attached.',
) {
  return {
    id: `${conversationId}:${providerMessageId}`,
    conversationId,
    providerMessageId,
    from,
    to: [{ name: null, email: ACCOUNT }],
    subject: 'Subject',
    sentAt: NOW,
    bodyText,
  }
}

beforeEach(async () => {
  await db.delete(messages)
  await db.delete(conversations)
  await db.delete(contactTags)
  await db.delete(contactContexts)
  await db.delete(accounts)
  await db.delete(sessions)
  await db.delete(users)

  await db.insert(users).values({ id: OWNER, email: OWNER, passwordHash: 'x' })
  await db.insert(accounts).values({
    id: ACCOUNT,
    email: ACCOUNT,
    userId: OWNER,
    refreshTokenEncrypted: 'x',
  })

  await db.insert(conversations).values([
    conversation('t-investor', { subject: 'Investor update' }),
    conversation('t-second', {
      subject: 'Re: Project X',
      state: 'informational',
      lastMessageAt: new Date('2026-11-19T10:00:00Z'),
    }),
    conversation('t-newsletter', {
      subject: 'Weekly digest',
      participants: [NEWS],
      state: 'low-priority',
      folder: 'archive',
    }),
  ])
  await db
    .insert(messages)
    .values([
      message('m1', `${ACCOUNT}:t-investor`),
      message('m2', `${ACCOUNT}:t-second`),
    ])

  await db.insert(contactTags).values({
    userId: OWNER,
    email: PRIYA.email,
    tag: 'investor',
    source: 'user',
  })
})

describe('list_threads', () => {
  test('defaults to the inbox and leaves archived mail out', async () => {
    const result = await listThreads(OWNER)
    const body = JSON.parse(result.content[0].text)

    expect(
      body.threads.map((row: { threadId: string }) => row.threadId),
    ).toEqual(['t-investor', 't-second'])
  })

  test('filters by person and tag', async () => {
    const byPerson = JSON.parse(
      (await listThreads(OWNER, { person: 'PRIYA@acme.example' })).content[0]
        .text,
    )
    expect(byPerson.total).toBe(2)

    const byTag = JSON.parse(
      (await listThreads(OWNER, { tag: 'Investor' })).content[0].text,
    )
    expect(
      byTag.threads.map((row: { threadId: string }) => row.threadId),
    ).toEqual(['t-investor', 't-second'])
  })

  test('reads every folder when asked', async () => {
    const result = JSON.parse(
      (await listThreads(OWNER, { folder: 'all' })).content[0].text,
    )
    expect(result.total).toBe(3)
  })
})

describe('search_mail', () => {
  test('matches message text and searches archived mail too', async () => {
    const result = JSON.parse(
      (await searchMail(OWNER, { query: 'nda' })).content[0].text,
    )

    expect(
      result.threads.map((row: { threadId: string }) => row.threadId),
    ).toEqual(['t-investor', 't-second'])
  })

  test('refuses an empty query', async () => {
    const result = await searchMail(OWNER, { query: '  ' })
    expect(result.isError).toBe(true)
  })
})

describe('get_thread', () => {
  test('returns the messages and the correspondent context', async () => {
    const result = JSON.parse(
      (await getThread(OWNER, { threadId: 't-investor' })).content[0].text,
    )

    expect(result.subject).toBe('Investor update')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].from.email).toBe(PRIYA.email)
    expect(result.messages[0].body).toContain('NDA')
  })

  test('reports a missing thread as an error', async () => {
    const result = await getThread(OWNER, { threadId: 'nope' })
    expect(result.isError).toBe(true)
  })
})

describe('people', () => {
  test('get_person returns tags and recent threads', async () => {
    const result = JSON.parse(
      (await getPerson(OWNER, { email: PRIYA.email })).content[0].text,
    )

    expect(result.tags).toEqual(['investor'])
    expect(result.recentThreads).toHaveLength(2)
  })

  test('update_person_tags adds and removes', async () => {
    const added = JSON.parse(
      (
        await updatePersonTags(OWNER, {
          email: PRIYA.email,
          add: ['vip'],
          remove: ['investor'],
        })
      ).content[0].text,
    )

    expect(added.tags).toEqual(['vip'])
  })

  test('update_person_notes changes only the fields it was given', async () => {
    await updatePersonNotes(OWNER, {
      email: PRIYA.email,
      currentWork: 'Closing the Series A.',
    })

    const result = JSON.parse(
      (
        await updatePersonNotes(OWNER, {
          email: PRIYA.email,
          relationship: 'lead investor',
        })
      ).content[0].text,
    )

    expect(result.context.currentWork).toBe('Closing the Series A.')
    expect(result.context.relationship).toBe('lead investor')
  })
})

describe('move_thread', () => {
  test('sets the user state override', async () => {
    const result = await moveThread(OWNER, {
      threadId: 't-investor',
      state: 'waiting-for-reply',
    })
    expect(result.isError).toBeUndefined()

    const filtered = JSON.parse(
      (await listThreads(OWNER, { state: 'waiting-for-reply' })).content[0]
        .text,
    )
    expect(
      filtered.threads.map((row: { threadId: string }) => row.threadId),
    ).toEqual(['t-investor'])
  })

  test('requires a state or a folder', async () => {
    const result = await moveThread(OWNER, { threadId: 't-investor' })
    expect(result.isError).toBe(true)
  })
})

describe('send_reply', () => {
  test('refuses to send without explicit confirmation', async () => {
    const result = await sendReplyConfirmed(OWNER, {
      threadId: 't-investor',
      body: 'Thanks, will review.',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('confirm: true')
  })
})
