import { beforeEach, describe, expect, test } from 'bun:test'

// No private temp database and no client teardown here. Bun shares one
// `#/db/index.ts` module across every test file in the run, so a local
// `DATABASE_URL` override after another file has imported it does nothing —
// and closing the shared client from an `afterAll` breaks every file that runs
// afterwards. `test/setup.ts` already points the suite at a temp file before any
// module loads, which is the isolation that matters.

const { eq } = await import('drizzle-orm')
const { db, initDatabase } = await import('#/db/index.ts')
const { accounts, contactContexts, contextRevisions, conversations, users } =
  await import('#/db/schema.ts')
const { saveContactContext } = await import('#/lib/contacts/context.ts')
const { conversationId } = await import('#/lib/conversation/model.ts')
const { setGoalIfUnset } = await import('#/lib/conversation/repository.ts')
const {
  latestLabelSource,
  listContextRevisions,
  listRecentContextRevisions,
  recordUserContactUpdate,
  recordUserLabelChange,
  undoContextRevision,
  writeAutoContextUpdate,
} = await import('./revisions.ts')

await initDatabase()

const OWNER = 'context-owner@example.com'
const ACCOUNT = 'context-me@example.com'
const THREAD = 'context-thread-1'
// The repository builds an id from the account and thread; the seed has to use
// the same shape or `setGoalIfUnset` cannot find the row.
const CONVERSATION = conversationId(ACCOUNT, THREAD)
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

describe('setGoalIfUnset', () => {
  test('writes an inferred goal, records it, and never replaces one', async () => {
    const written = await setGoalIfUnset(
      OWNER,
      ACCOUNT,
      THREAD,
      'Confirm the Tuesday date',
    )
    expect(written).not.toBeNull()
    if (!written) return

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, CONVERSATION))
    expect(row.goal).toBe('Confirm the Tuesday date')

    const [revision] = await listContextRevisions(
      OWNER,
      'conversation',
      CONVERSATION,
    )
    expect(revision).toMatchObject({
      id: written.revisionId,
      field: 'goal',
      previousValue: null,
      nextValue: 'Confirm the Tuesday date',
      source: 'auto',
    })

    // A second inference must not take a goal that is already set.
    expect(
      await setGoalIfUnset(OWNER, ACCOUNT, THREAD, 'Something else'),
    ).toBeNull()

    expect(await undoContextRevision(OWNER, written.revisionId)).toBe(true)
    const [afterUndo] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, CONVERSATION))
    expect(afterUndo.goal).toBeNull()
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

    const [goal] = await listContextRevisions(
      OWNER,
      'conversation',
      CONVERSATION,
    )
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

describe('contact provenance', () => {
  test('records a user edit and keeps it out of the next refresh', async () => {
    await writeAutoContextUpdate({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      goal: { previous: null, next: null },
      contact: {
        email: SENDER,
        previous: EMPTY,
        next: { ...EMPTY, roleCompany: 'AI wording' },
      },
    })

    const previous = {
      email: SENDER,
      ...EMPTY,
      roleCompany: 'AI wording',
      summary: '',
      importance: null,
      sources: { roleCompany: 'auto' as const },
    }

    // The route saves first, then records — the revision names the value that
    // was replaced, so it must be written after the row holds the new one.
    await saveContactContext(OWNER, SENDER, {
      ...EMPTY,
      roleCompany: 'My wording',
      importance: null,
    })
    const recorded = await recordUserContactUpdate({
      userId: OWNER,
      email: SENDER,
      threadId: THREAD,
      previous,
      next: { ...EMPTY, roleCompany: 'My wording', importance: null },
    })
    expect(recorded).toBe(1)

    const [revision] = await listContextRevisions(OWNER, 'contact', SENDER)
    expect(revision).toMatchObject({
      field: 'roleCompany',
      previousValue: 'AI wording',
      nextValue: 'My wording',
      source: 'user',
    })

    // The next mail proposes the old guess again; the user's wording wins.
    const refreshed = await writeAutoContextUpdate({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      goal: { previous: null, next: null },
      contact: {
        email: SENDER,
        previous: { ...EMPTY, roleCompany: 'My wording' },
        next: { ...EMPTY, roleCompany: 'AI again' },
      },
    })
    expect(refreshed).toBe(0)

    const [contact] = await db
      .select()
      .from(contactContexts)
      .where(eq(contactContexts.email, SENDER))
    expect(contact.roleCompany).toBe('My wording')
    expect(contact.sources).toEqual({ roleCompany: 'user' })
  })

  test('writes the short summary and marks it automatic', async () => {
    const changed = await writeAutoContextUpdate({
      userId: OWNER,
      conversationId: CONVERSATION,
      providerThreadId: THREAD,
      goal: { previous: null, next: null },
      contact: {
        email: SENDER,
        previous: EMPTY,
        previousSummary: '',
        next: {
          ...EMPTY,
          summary: 'Sam leads Northwind and is buying the Q3 rollout.',
        },
      },
    })

    expect(changed).toBe(1)
    const [contact] = await db
      .select()
      .from(contactContexts)
      .where(eq(contactContexts.email, SENDER))
    expect(contact.summary).toBe(
      'Sam leads Northwind and is buying the Q3 rollout.',
    )
    expect(contact.sources).toEqual({ summary: 'auto' })
  })
})
