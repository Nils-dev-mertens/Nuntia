import { beforeEach, describe, expect, test } from 'bun:test'

const { db, initDatabase } = await import('#/db/index.ts')
const { accounts, conversations, messages, users } =
  await import('#/db/schema.ts')
const { listContactActivity, listContactThreads, loadContactHistory } =
  await import('./history.ts')

await initDatabase()

const OWNER = 'history-owner@example.com'
const ACCOUNT = 'history-me@example.com'
const CONTACT = 'history-sam@example.com'

const sender = { name: 'Sam', email: CONTACT }

function conversation(
  id: string,
  providerThreadId: string,
  lastMessageAt: string,
  participants = [sender],
) {
  return {
    id,
    accountId: ACCOUNT,
    providerThreadId,
    subject: `Subject ${providerThreadId}`,
    participants,
    lastMessageAt: new Date(lastMessageAt),
  }
}

function message(
  id: string,
  conversationId: string,
  providerMessageId: string,
  sentAt: string,
  body: string,
  from = sender,
) {
  return {
    id,
    conversationId,
    providerMessageId,
    from,
    to: [],
    subject: 'Subject',
    sentAt: new Date(sentAt),
    bodyText: body,
  }
}

beforeEach(async () => {
  await db.delete(messages)
  await db.delete(conversations)
  await db.delete(accounts)
  await db.delete(users)

  await db.insert(users).values({ id: OWNER, email: OWNER, passwordHash: 'x' })
  await db.insert(accounts).values({
    id: ACCOUNT,
    email: ACCOUNT,
    userId: OWNER,
    refreshTokenEncrypted: 'x',
  })
})

describe('loadContactHistory', () => {
  test('returns other threads the correspondent wrote in, newest first', async () => {
    await db
      .insert(conversations)
      .values([
        conversation('conversation-current', 'thread-current', '2024-03-01'),
        conversation('conversation-older', 'thread-older', '2024-01-01'),
        conversation('conversation-newer', 'thread-newer', '2024-02-01'),
      ])
    await db
      .insert(messages)
      .values([
        message('m1', 'conversation-current', 'p1', '2024-03-01', 'current'),
        message('m2', 'conversation-older', 'p2', '2024-01-01', 'older one'),
        message('m3', 'conversation-older', 'p3', '2024-01-02', 'older two'),
        message('m4', 'conversation-newer', 'p4', '2024-02-01', 'newer'),
      ])

    const history = await loadContactHistory(OWNER, CONTACT, {
      excludeProviderThreadId: 'thread-current',
    })

    expect(history.map((thread) => thread.providerThreadId)).toEqual([
      'thread-newer',
      'thread-older',
    ])
    // The prompt reads oldest to newest, like the current thread.
    expect(history[1].messages.map((entry) => entry.body)).toEqual([
      'older one',
      'older two',
    ])
  })

  test('ignores threads the contact only received, and another user’s mail', async () => {
    await db
      .insert(conversations)
      .values([
        conversation('conversation-received', 'thread-received', '2024-02-01'),
        conversation('conversation-sent', 'thread-sent', '2024-01-01'),
      ])
    await db
      .insert(messages)
      .values([
        message(
          'm-received',
          'conversation-received',
          'p-received',
          '2024-02-01',
          'I wrote this',
          { name: 'Me', email: ACCOUNT },
        ),
        message(
          'm-sent',
          'conversation-sent',
          'p-sent',
          '2024-01-01',
          'Sam wrote this',
        ),
      ])

    const history = await loadContactHistory(OWNER, CONTACT)
    expect(history.map((thread) => thread.providerThreadId)).toEqual([
      'thread-sent',
    ])

    expect(
      await loadContactHistory('someone-else@example.com', CONTACT),
    ).toEqual([])
  })
})

describe('listContactThreads', () => {
  test('lists every thread the address appears on, including one they only received', async () => {
    await db
      .insert(conversations)
      .values([
        conversation('conversation-replied', 'thread-replied', '2024-02-01'),
        conversation('conversation-received', 'thread-received', '2024-01-01', [
          { name: 'Me', email: ACCOUNT },
          sender,
        ]),
        conversation('conversation-other', 'thread-other', '2024-03-01', [
          { name: 'Other', email: 'other@example.com' },
        ]),
      ])

    const threads = await listContactThreads(OWNER, CONTACT)
    expect(threads.map((thread) => thread.providerThreadId)).toEqual([
      'thread-replied',
      'thread-received',
    ])
    expect(threads[0]).toMatchObject({
      subject: 'Subject thread-replied',
      state: 'informational',
      done: false,
      unread: false,
    })
  })
})

describe('listContactActivity', () => {
  test('keeps the newest thread for each participant in one read', async () => {
    await db
      .insert(conversations)
      .values([
        conversation('conversation-older', 'thread-older', '2024-01-01'),
        conversation('conversation-newer', 'thread-newer', '2024-02-01', [
          sender,
          { name: 'Me', email: ACCOUNT },
        ]),
      ])

    const activity = await listContactActivity(OWNER)
    expect(activity.get(CONTACT)).toEqual({
      subject: 'Subject thread-newer',
      lastMessageAt: new Date('2024-02-01').toISOString(),
    })
    // The owner is a participant too; the map is by address, not by side.
    expect(activity.get(ACCOUNT)?.subject).toBe('Subject thread-newer')
  })
})
