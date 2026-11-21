/**
 * Erasing a user.
 *
 * The cascade is the whole point, so the fixture writes a row into every table
 * that references a user and the assertions read the result back from SQLite
 * rather than trusting the delete's exit code. A second user is populated with
 * the same kinds of rows to prove the erase is scoped to one person.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-erasure-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, client, initDatabase } = await import('#/db/index.ts')
const {
  accessRequests,
  accounts,
  appSettings,
  attachments,
  contactContexts,
  contactOrganizations,
  contactTagDescriptions,
  contactTagEvents,
  contactTags,
  contextRevisions,
  conversations,
  decisions,
  feedback,
  formAnswers,
  formAudience,
  formParticipation,
  formQuestions,
  formResponses,
  forms,
  inviteRedemptions,
  invites,
  messages,
  organizationLabels,
  organizationRules,
  productEvents,
  sessions,
  stateLabels,
  users,
} = await import('#/db/schema.ts')
const { eraseUser, planUserErasure } = await import('#/lib/auth/erasure.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const ERASED = 'erasure-target@example.test'
const KEPT = 'erasure-bystander@example.test'
const HASH = '$argon2id$test-only'

/** Tables with a `user_id` column of their own. */
const USER_ID_TABLES = [
  'sessions',
  'app_settings',
  'contact_contexts',
  'contact_tags',
  'contact_tag_descriptions',
  'contact_organizations',
  'contact_tag_events',
  'context_revisions',
  'organization_labels',
  'state_labels',
  'feedback',
  'product_events',
  'form_audience',
  'form_participation',
  'form_responses',
  'invite_redemptions',
  'accounts',
]

async function countRows(sql: string, args: string[] = []): Promise<number> {
  const result = await client.execute({ sql, args })
  return Number(result.rows[0]?.n ?? 0)
}

/** Write one row into every user-owned table for one person. */
async function populate(userId: string): Promise<void> {
  const now = new Date()
  const accountId = `mailbox-${userId}`
  const threadId = `thread-${userId}`
  const messageId = `${threadId}:message`
  const labelId = `label-${userId}`
  const formId = `form-${userId}`
  const questionId = `question-${userId}`
  const responseId = `response-${userId}`
  const inviteId = `invite-${userId}`
  const requestId = `request-${userId}`

  await db.insert(users).values({
    id: userId,
    email: userId,
    passwordHash: HASH,
  })

  await db.insert(sessions).values({
    id: `session-${userId}`,
    userId,
    tokenHash: 'hash',
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
  })

  await db.insert(accounts).values({
    id: accountId,
    userId,
    email: accountId,
    refreshTokenEncrypted: 'v1:a:b:c',
  })

  await db.insert(conversations).values({
    id: threadId,
    accountId,
    providerThreadId: 't1',
    subject: 'Launch',
    participants: [{ email: 'other@example.test' }],
    lastMessageAt: now,
  })

  await db.insert(messages).values({
    id: messageId,
    conversationId: threadId,
    providerMessageId: 'm1',
    from: { email: 'other@example.test' },
    to: [{ email: userId }],
    subject: 'Launch',
    sentAt: now,
  })

  await db.insert(attachments).values({
    id: `attachment-${userId}`,
    conversationId: threadId,
    messageId,
    providerAttachmentId: 'a1',
    filename: 'brief.pdf',
    mimeType: 'application/pdf',
  })

  await db.insert(decisions).values({
    id: `decision-${userId}`,
    conversationId: threadId,
    state: 'needs-action',
    importance: 7,
    urgency: 6,
    requiresReply: true,
    intent: 'request',
    reasoning: 'Names a deadline.',
  })

  await db.insert(appSettings).values({ id: `settings-${userId}`, userId })

  await db.insert(contactContexts).values({
    userId,
    email: 'other@example.test',
    summary: 'Works on the launch.',
  })

  await db.insert(contactTags).values({
    userId,
    email: 'other@example.test',
    tag: 'client',
  })

  await db.insert(contactTagDescriptions).values({
    userId,
    tag: 'client',
    description: 'People who pay.',
  })

  await db.insert(contactOrganizations).values({
    userId,
    domain: 'example.test',
    focus: 'Analytics',
  })

  await db.insert(contactTagEvents).values({
    id: `tag-event-${userId}`,
    userId,
    tag: 'client',
    email: 'other@example.test',
    action: 'added',
    source: 'user',
  })

  await db.insert(contextRevisions).values({
    id: `revision-${userId}`,
    userId,
    scope: 'contact',
    target: 'other@example.test',
    field: 'summary',
    nextValue: 'Works on the launch.',
    source: 'user',
  })

  await db.insert(organizationLabels).values({
    id: labelId,
    userId,
    name: 'Invoices',
    position: 0,
  })

  await db.insert(organizationRules).values({
    id: `rule-${userId}`,
    labelId,
    field: 'subject-contains',
    value: 'invoice',
    position: 0,
  })

  await db.insert(stateLabels).values({
    userId,
    state: 'needs-action',
    name: 'Do this now',
  })

  await db.insert(feedback).values({
    id: `feedback-${userId}`,
    userId,
    message: 'The composer lost my draft.',
  })

  await db.insert(productEvents).values({
    id: `event-${userId}`,
    userId,
    name: 'draft-generated',
  })

  await db.insert(forms).values({
    id: formId,
    title: 'How is the beta?',
    status: 'open',
    createdBy: userId,
  })

  await db.insert(formQuestions).values({
    id: questionId,
    formId,
    key: 'q1',
    position: 0,
    type: 'short-text',
    prompt: 'Anything else?',
  })

  await db.insert(formAudience).values({ formId, userId })

  await db.insert(formParticipation).values({ formId, userId, shownAt: now })

  await db.insert(formResponses).values({
    id: responseId,
    formId,
    userId,
    submittedAt: now,
  })

  await db.insert(formAnswers).values({
    id: `answer-${userId}`,
    responseId,
    questionId,
    valueText: 'No.',
  })

  await db.insert(invites).values({
    id: inviteId,
    codeHash: `hash-${userId}`,
    email: userId,
    createdBy: userId,
  })

  await db.insert(inviteRedemptions).values({
    id: `redemption-${userId}`,
    inviteId,
    userId,
  })

  // Kept by design: the address asked for access, but the row is the operator's
  // record of that decision rather than part of the person's account.
  await db.insert(accessRequests).values({
    id: requestId,
    email: userId,
    note: 'Please let me in.',
    status: 'approved',
    decidedBy: userId,
  })
}

/**
 * Remove this file's fixture.
 *
 * Accounts first is harmless rather than necessary now that startup rebuilds
 * the cascading owner keys (`src/db/rebuild-user-cascades.ts`).
 *
 * Invites and access requests are deleted by address too, because they outlive
 * the user on purpose (`created_by` is SET NULL), and `invites.code_hash` is
 * unique, so leaving them behind would break the next populate.
 */
async function clean(): Promise<void> {
  await db.delete(accounts)
  await db.delete(users)
  await db.delete(invites)
  await db.delete(accessRequests)
}

beforeEach(async () => {
  await clean()
  await populate(ERASED)
  await populate(KEPT)
})

afterEach(clean)

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

describe('planUserErasure', () => {
  test('counts the mail and the retained records', async () => {
    const plan = await planUserErasure(ERASED)

    expect(plan.user?.email).toBe(ERASED)
    expect(plan.mail.accounts).toBe(1)
    expect(plan.mail.conversations).toBe(1)
    expect(plan.mail.messages).toBe(1)
    expect(plan.mail.attachments).toBe(1)
    expect(plan.mail.decisions).toBe(1)
    expect(plan.retained.invites).toBe(1)
    expect(plan.retained.accessRequests).toBe(1)
  })

  test('reports an unknown address instead of throwing', async () => {
    const plan = await planUserErasure('nobody@example.test')

    expect(plan.user).toBeNull()
    expect(plan.tables.every((entry) => entry.rows === 0)).toBe(true)
  })
})

describe('the owner foreign keys', () => {
  test('are stored as cascades, not NO ACTION', async () => {
    for (const table of ['accounts', 'app_settings']) {
      const keys = await client.execute(`PRAGMA foreign_key_list("${table}")`)
      const owner = keys.rows.find((row) => String(row.from) === 'user_id')

      expect(`${table}:${String(owner?.on_delete).toUpperCase()}`).toBe(
        `${table}:CASCADE`,
      )
    }
  })

  test('deleting the user takes the mailbox and the settings with it', async () => {
    // A fixture of its own rather than the shared one, so this test depends on
    // nothing but the two constraints it is about.
    const id = 'cascade-check@example.test'
    await db.insert(users).values({ id, email: id, passwordHash: HASH })
    await db.insert(accounts).values({
      id: 'cascade-mailbox',
      userId: id,
      email: 'cascade-mailbox@example.test',
      refreshTokenEncrypted: 'v1:a:b:c',
    })
    await db.insert(appSettings).values({ id: 'cascade-settings', userId: id })

    await db.delete(users).where(eq(users.id, id))

    expect(
      await countRows('SELECT count(*) AS n FROM accounts WHERE id = ?', [
        'cascade-mailbox',
      ]),
    ).toBe(0)
    expect(
      await countRows('SELECT count(*) AS n FROM app_settings WHERE id = ?', [
        'cascade-settings',
      ]),
    ).toBe(0)
  })
})

describe('eraseUser', () => {
  test('removes every user-owned row and leaves the other user alone', async () => {
    const report = await eraseUser(ERASED)

    expect(report.deleted.mail.conversations).toBe(1)
    expect(report.deleted.mail.messages).toBe(1)

    // Read back from SQLite rather than trusting the delete: every table the
    // fixture wrote to must be empty for this user.
    const leftovers: Array<{ table: string; rows: number }> = []
    for (const table of USER_ID_TABLES) {
      const rows = await countRows(
        `SELECT count(*) AS n FROM "${table}" WHERE "user_id" = ?`,
        [ERASED],
      )
      if (rows > 0) leftovers.push({ table, rows })
    }

    expect(leftovers).toEqual([])

    // Rows that hang off the user's rows rather than the user themselves.
    expect(
      await countRows('SELECT count(*) AS n FROM forms WHERE created_by = ?', [ERASED]),
    ).toBe(0)
    expect(
      await countRows('SELECT count(*) AS n FROM organization_rules WHERE label_id = ?', [
        `label-${ERASED}`,
      ]),
    ).toBe(0)
    expect(
      await countRows('SELECT count(*) AS n FROM form_questions WHERE form_id = ?', [
        `form-${ERASED}`,
      ]),
    ).toBe(0)
    expect(
      await countRows('SELECT count(*) AS n FROM form_answers WHERE response_id = ?', [
        `response-${ERASED}`,
      ]),
    ).toBe(0)
    expect(await countRows('SELECT count(*) AS n FROM users WHERE id = ?', [ERASED])).toBe(0)
    expect(
      await countRows(
        'SELECT count(*) AS n FROM conversations WHERE account_id = ?',
        [`mailbox-${ERASED}`],
      ),
    ).toBe(0)

    // The bystander still has everything.
    expect(await countRows('SELECT count(*) AS n FROM users WHERE id = ?', [KEPT])).toBe(1)
    expect(
      await countRows('SELECT count(*) AS n FROM messages WHERE conversation_id = ?', [
        `thread-${KEPT}`,
      ]),
    ).toBe(1)
    expect(
      await countRows('SELECT count(*) AS n FROM contact_tags WHERE user_id = ?', [KEPT]),
    ).toBe(1)

    // And the access request stays, as the plan said it would.
    expect(
      await countRows('SELECT count(*) AS n FROM access_requests WHERE email = ?', [ERASED]),
    ).toBe(1)
  })

  test('refuses an address that has no account', async () => {
    await expect(eraseUser('nobody@example.test')).rejects.toThrow(
      /No user "nobody@example.test"/,
    )
  })
})
