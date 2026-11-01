import { beforeEach, describe, expect, test } from 'bun:test'

// No private temp database and no client teardown here. Bun shares one
// `#/db/index.ts` module across every test file in the run, so a local
// `DATABASE_URL` override after another file has imported it does nothing —
// and closing the shared client from an `afterAll` breaks every file that runs
// afterwards. `test/setup.ts` already points the suite at a temp file before any
// module loads, which is the isolation that matters.

const { eq } = await import('drizzle-orm')
const { db, initDatabase } = await import('#/db/index.ts')
const {
  accounts,
  contactContexts,
  contextRevisions,
  conversations,
  users,
} = await import('#/db/schema.ts')
const {
  latestLabelSource,
  listContextRevisions,
  listRecentContextRevisions,
  recordUserLabelChange,
  undoContextRevision,
  writeAutoContextUpdate,
} = await import('./revisions.ts')

await initDatabase()

const OWNER = 'context-owner@example.com'
const ACCOUNT = 'context-me@example.com'
const CONVERSATION = 'context-conv-1'
const THREAD = 'context-thread-1'
const SENDER = 'context-ana@example.com'

const EMPTY = {
  roleCompany: '',
  relationship: '',
  topics: '',
  currentWork: '',
}

beforeEach(async () => {
  await db.delete(contextRevisions)
  await db.delete(contactContexts)
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
  await db.insert(conversations).values({
    id: CONVERSATION,
    accountId: ACCOUNT,
    providerThreadId: THREAD,
    subject: 'Launch schedule',
    lastMessageAt: new Date('2024-01-15T10:00:00Z'),
  })
})

describe('writeAutoContextUpdate', () => {
  test('writes the change and records what it replaced', async () => {
    const changed = await writeAutoContextUpdate({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      goal: { previous: null, next: 'Confirm the Tuesday date' },
      contact: {
        email: SENDER,
        previous: EMPTY,
        next: { ...EMPTY, roleCompany: 'Northwind, PM' },
      },
    })

    expect(changed).toBe(2)

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, CONVERSATION))
    expect(row.goal).toBe('Confirm the Tuesday date')

    const [contact] = await db
      .select()
      .from(contactContexts)
      .where(eq(contactContexts.email, SENDER))
    expect(contact.roleCompany).toBe('Northwind, PM')

    const [goal] = await listContextRevisions(OWNER, 'conversation', CONVERSATION)
    expect(goal).toMatchObject({
      field: 'goal',
      previousValue: null,
      nextValue: 'Confirm the Tuesday date',
      source: 'auto',
      threadId: THREAD,
    })

    const [profile] = await listContextRevisions(OWNER, 'contact', SENDER)
    expect(profile).toMatchObject({
      field: 'roleCompany',
      previousValue: null,
      nextValue: 'Northwind, PM',
      source: 'auto',
    })
  })

  test('records a label the decision layer assigned', async () => {
    const changed = await writeAutoContextUpdate({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      goal: { previous: null, next: null },
      label: { previous: null, next: 'label-to-pay' },
      contact: null,
    })

    expect(changed).toBe(1)

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, CONVERSATION))
    expect(row.organizationGroupId).toBe('label-to-pay')

    const [revision] = await listContextRevisions(
      OWNER,
      'conversation',
      CONVERSATION,
    )
    expect(revision).toMatchObject({
      field: 'label',
      previousValue: null,
      nextValue: 'label-to-pay',
      source: 'auto',
    })
  })

  test('an unchanged field writes nothing and an empty proposal never clears a value', async () => {
    await writeAutoContextUpdate({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      goal: { previous: null, next: 'Confirm the Tuesday date' },
      contact: {
        email: SENDER,
        previous: EMPTY,
        next: { ...EMPTY, roleCompany: 'Northwind, PM' },
      },
    })

    // The same answer again, plus a proposal that says nothing about the
    // profile. Neither may produce a revision or erase what is stored.
    const unchanged = await writeAutoContextUpdate({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      goal: {
        previous: 'Confirm the Tuesday date',
        next: 'Confirm the Tuesday date',
      },
      contact: {
        email: SENDER,
        previous: { ...EMPTY, roleCompany: 'Northwind, PM' },
        next: EMPTY,
      },
    })

    expect(unchanged).toBe(0)
    expect(
      await listContextRevisions(OWNER, 'conversation', CONVERSATION),
    ).toHaveLength(1)
    expect(await listContextRevisions(OWNER, 'contact', SENDER)).toHaveLength(1)

    const [contact] = await db
      .select()
      .from(contactContexts)
      .where(eq(contactContexts.email, SENDER))
    expect(contact.roleCompany).toBe('Northwind, PM')
  })
})

describe('undoContextRevision', () => {
  test('restores the previous value and records the restoration', async () => {
    await writeAutoContextUpdate({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      goal: { previous: null, next: 'Confirm the Tuesday date' },
      contact: null,
    })

    const [revision] = await listContextRevisions(
      OWNER,
      'conversation',
      CONVERSATION,
    )
    expect(await undoContextRevision(OWNER, revision.id)).toBe(true)

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, CONVERSATION))
    expect(row.goal).toBeNull()

    // Undo is a write like any other, so the history explains itself and a
    // second undo of the same row is refused rather than repeating.
    const rows = await listContextRevisions(OWNER, 'conversation', CONVERSATION)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      source: 'user',
      previousValue: 'Confirm the Tuesday date',
      nextValue: null,
    })
    expect(await undoContextRevision(OWNER, revision.id)).toBe(false)
  })

  test('puts a thread back in the section it was taken out of', async () => {
    await writeAutoContextUpdate({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      goal: { previous: null, next: null },
      label: { previous: null, next: 'label-to-pay' },
      contact: null,
    })

    const [revision] = await listContextRevisions(
      OWNER,
      'conversation',
      CONVERSATION,
    )
    expect(await undoContextRevision(OWNER, revision.id)).toBe(true)

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, CONVERSATION))
    expect(row.organizationGroupId).toBeNull()
  })

  test('refuses another user’s revision', async () => {
    await writeAutoContextUpdate({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      goal: { previous: null, next: 'Confirm the Tuesday date' },
      contact: null,
    })

    const [revision] = await listContextRevisions(
      OWNER,
      'conversation',
      CONVERSATION,
    )
    expect(await undoContextRevision('someone@else.com', revision.id)).toBe(
      false,
    )
  })
})

describe('latestLabelSource', () => {
  test('knows whether the app or the user filed the thread', async () => {
    expect(await latestLabelSource(OWNER, CONVERSATION)).toBeNull()

    await writeAutoContextUpdate({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      goal: { previous: null, next: null },
      label: { previous: null, next: 'label-guess' },
      contact: null,
    })
    expect(await latestLabelSource(OWNER, CONVERSATION)).toBe('auto')

    // The user overrules it: from here the decision layer must leave the thread
    // alone, which is the whole reason the source is written down.
    await recordUserLabelChange({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      previous: 'label-guess',
      next: 'label-mine',
    })
    expect(await latestLabelSource(OWNER, CONVERSATION)).toBe('user')
  })

  test('a hand move that changes nothing writes no revision', async () => {
    await recordUserLabelChange({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      previous: 'label-a',
      next: 'label-a',
    })

    expect(await latestLabelSource(OWNER, CONVERSATION)).toBeNull()
  })
})

describe('listRecentContextRevisions', () => {
  test('names the thread a change came from and marks undone rows', async () => {
    await writeAutoContextUpdate({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      goal: { previous: null, next: 'Confirm the Tuesday date' },
      contact: null,
    })

    const mine = (await listRecentContextRevisions(OWNER)).filter(
      (revision) => revision.subject === 'Launch schedule',
    )
    expect(mine[0]).toMatchObject({
      field: 'goal',
      nextValue: 'Confirm the Tuesday date',
      undone: false,
    })

    await undoContextRevision(OWNER, mine[0].id)

    const after = (await listRecentContextRevisions(OWNER)).filter(
      (revision) => revision.id === mine[0].id,
    )
    expect(after[0].undone).toBe(true)
  })
})
