/**
 * Sending a new message.
 *
 * Every refusal here is a message the composer shows, so they are asserted by
 * their sentence as well as by their effect: a validation that produces the
 * wrong wording is a bug the user sees. The provider is a fake, so the send path
 * — ownership check, recipient parsing, attachment limits, call into the adapter
 * — is exercised without a credential.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

// A database of its own, before any module reads DATABASE_URL.
const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-send-new-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`
process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)

const { db, initDatabase } = await import('#/db/index.ts')
const {
  accounts,
  contacts,
  conversations,
  messages: messagesTable,
  senderProfiles,
  sessions,
  users,
} = await import('#/db/schema.ts')
const { registerUser } = await import('#/lib/auth/index.ts')
const { FakeMailboxClient } = await import('./fake.ts')
const { sendNewMessage } = await import('./send-new.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const OWNER = 'owner@example.com'
const OTHER = 'other@example.com'
const PASSWORD = 'correct horse battery'

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(sessions)
  await db.delete(accounts)
  await db.delete(users)

  await registerUser({ email: OWNER, password: PASSWORD })
  await db.insert(accounts).values({
    id: OWNER,
    email: OWNER,
    userId: OWNER,
    refreshTokenEncrypted: 'v1:a:b:c',
  })
})

/** A send from the connected mailbox, with a fake client standing in. */
function send(
  overrides: Partial<Parameters<typeof sendNewMessage>[0]> = {},
  client = new FakeMailboxClient(),
) {
  return sendNewMessage(
    {
      userId: OWNER,
      accountId: OWNER,
      to: ['friend@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      body: 'A first message.',
      ...overrides,
    },
    { clientFor: async () => client },
  )
}

describe('sendNewMessage', () => {
  test('hands the provider a structured message and reports the thread', async () => {
    const client = new FakeMailboxClient()
    const result = await send(
      { cc: ['cc@example.com'], bcc: ['bcc@example.com'] },
      client,
    )

    expect(result.threadId).toBe('thread-new-1')
    expect(client.started).toHaveLength(1)
    expect(client.started[0]?.subject).toBe('Hello')
    expect(client.started[0]?.to).toEqual(['friend@example.com'])
    expect(client.started[0]?.cc).toEqual(['cc@example.com'])
    expect(client.started[0]?.bcc).toEqual(['bcc@example.com'])
    expect(client.started[0]?.html).toContain('A first message.')
  })

  test('accepts an address list with commas and folded case, without duplicates', async () => {
    const client = new FakeMailboxClient()
    await send(
      { to: ['A@example.com ', 'a@example.com', 'b@example.com'] },
      client,
    )

    expect(client.started[0]?.to).toEqual(['A@example.com', 'b@example.com'])
  })

  test('refuses a message with nobody to send it to', async () => {
    await expect(send({ to: [], cc: [], bcc: [] })).rejects.toThrow(
      /at least one recipient/i,
    )
  })

  test('refuses a malformed address by name', async () => {
    await expect(send({ to: ['not-an-address'] })).rejects.toThrow(
      'not-an-address is not a valid email address.',
    )
  })

  test('refuses an empty subject and an empty body', async () => {
    await expect(send({ subject: '  ' })).rejects.toThrow(
      /give the message a subject/i,
    )
    await expect(send({ body: '   ' })).rejects.toThrow(/empty message/i)
  })

  test('allows an attachment-only message', async () => {
    const client = new FakeMailboxClient()
    await send(
      {
        body: '',
        attachments: [
          {
            filename: 'note.txt',
            contentType: 'text/plain',
            data: Buffer.from('hello').toString('base64'),
          },
        ],
      },
      client,
    )

    expect(client.started[0]?.attachments[0]?.data.byteLength).toBe(5)
  })

  test('rejects an attachment that is not base64 before calling the provider', async () => {
    const client = new FakeMailboxClient()
    await expect(
      send(
        {
          attachments: [
            { filename: 'x.bin', contentType: 'x/test', data: 'not base64' },
          ],
        },
        client,
      ),
    ).rejects.toThrow(/could not be read/i)
    expect(client.started).toHaveLength(0)
  })

  test('refuses a mailbox the user does not own', async () => {
    await expect(send({ accountId: OTHER })).rejects.toThrow(
      /not connected to this account/i,
    )
  })

  test('reports a missing mailbox client as a reconnect, not a crash', async () => {
    await expect(
      send({}, new FakeMailboxClient()).then(() => null),
    ).resolves.toBe(null)

    await expect(
      sendNewMessage(
        {
          userId: OWNER,
          accountId: OWNER,
          to: ['friend@example.com'],
          cc: [],
          bcc: [],
          subject: 'Hello',
          body: 'Hi',
        },
        { clientFor: async () => null },
      ),
    ).rejects.toThrow(/needs reconnecting/i)
  })

  test('remembers everyone it just wrote to, for the next recipient list', async () => {
    await send({
      to: ['newfriend@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
    })

    const rows = await db.select().from(contacts)
    expect(rows.map((row) => row.email).sort()).toEqual([
      'bcc@example.com',
      'cc@example.com',
      'newfriend@example.com',
    ])
  })

  test('learns nothing from a send that was refused', async () => {
    await expect(
      send({ to: ['not-an-address'], cc: ['cc@example.com'] }),
    ).rejects.toThrow(/not a valid email address/i)

    expect(await db.select().from(contacts)).toEqual([])
  })

  test('does not fail the send when storing the sent thread fails', async () => {
    // The fake's thread id resolves to nothing, so the refresh throws; the
    // message has already gone out and must still be reported as sent.
    const client = new FakeMailboxClient()
    const result = await send({}, client)
    expect(result.threadId).toBe('thread-new-1')
    expect(client.started).toHaveLength(1)
  })
})

/**
 * The point of the whole feature: the user types only the message. Which pair of
 * greeting/signature is added follows the same three sources a reply uses, in
 * the same order, because it is the same function.
 */
describe('the greeting and signature a new message goes out with', () => {
  test('uses the recipient’s saved style when they have one enabled', async () => {
    await db.insert(senderProfiles).values({
      id: `${OWNER}:friend@example.com`,
      accountId: OWNER,
      senderEmail: 'friend@example.com',
      replyStyleEnabled: true,
      replyGreeting: 'Hoi Nils,',
      replySignature: 'Groet,\nBram',
    })

    const client = new FakeMailboxClient()
    await send({ body: 'Lunch donderdag?' }, client)

    expect(client.started[0]?.text).toBe(
      'Hoi Nils,\n\nLunch donderdag?\n\nGroet,\nBram',
    )
  })

  test('falls back to the account-wide pair for anyone else', async () => {
    await db
      .update(accounts)
      .set({
        defaultReplyGreeting: 'Hallo,',
        defaultReplySignature: 'Met vriendelijke groet,\nBram',
      })
      .where(eq(accounts.id, OWNER))

    const client = new FakeMailboxClient()
    await send({ to: ['stranger@example.com'], body: 'Even kort.' }, client)

    expect(client.started[0]?.text).toBe(
      'Hallo,\n\nEven kort.\n\nMet vriendelijke groet,\nBram',
    )
  })

  test('falls back to how the user signed their own last sent mail', async () => {
    await db.insert(conversations).values({
      id: 'stored-1',
      accountId: OWNER,
      providerThreadId: 'stored-1',
      subject: 'Earlier mail',
      participants: [{ name: null, email: 'stranger@example.com' }],
      lastMessageAt: new Date(),
    })
    await db.insert(messagesTable).values({
      id: 'stored-1:m1',
      conversationId: 'stored-1',
      providerMessageId: 'm1',
      from: { name: null, email: OWNER },
      to: [{ name: null, email: 'stranger@example.com' }],
      subject: 'Earlier mail',
      sentAt: new Date(),
      isFromAccountOwner: true,
      detectedGreetingText: 'Dag allen,',
      detectedSignatureText: 'Bram',
    })

    const client = new FakeMailboxClient()
    await send({ to: ['stranger@example.com'], body: 'Tot morgen.' }, client)

    expect(client.started[0]?.text).toBe('Dag allen,\n\nTot morgen.\n\nBram')
  })

  test('sends the typed body alone when nothing is known yet', async () => {
    const client = new FakeMailboxClient()
    await send({ to: ['fresh@example.com'], body: 'Hello.' }, client)

    expect(client.started[0]?.text).toBe('Hello.')
  })
})
