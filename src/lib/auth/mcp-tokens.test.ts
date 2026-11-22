/**
 * Agent tokens.
 *
 * The properties that matter: the secret is returned once and never stored, a
 * token only works for its owner, and revoking one takes effect immediately.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A database of its own, before any module reads DATABASE_URL.
const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-mcp-token-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`
process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)

const { db, initDatabase } = await import('#/db/index.ts')
const { mcpTokens, users } = await import('#/db/schema.ts')
const { createMcpToken, listMcpTokens, revokeMcpToken, userFromMcpToken } =
  await import('#/lib/auth/mcp-tokens.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const ALICE = 'alice@example.com'
const BOB = 'bob@example.com'

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(mcpTokens)
  await db.delete(users)
  await db.insert(users).values([
    { id: ALICE, email: ALICE, passwordHash: 'x' },
    { id: BOB, email: BOB, passwordHash: 'x' },
  ])
})

describe('agent tokens', () => {
  test('returns the secret once and stores only a hash', async () => {
    const created = await createMcpToken(ALICE, '  Claude Code  ')

    expect(created.token.startsWith('mcp_')).toBe(true)
    expect(created.name).toBe('Claude Code')

    const [row] = await db.select().from(mcpTokens)
    expect(row.tokenHash).not.toContain(created.token)
    expect(row.name).toBe('Claude Code')

    const listed = await listMcpTokens(ALICE)
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(created.id)
    expect('token' in listed[0]).toBe(false)
  })

  test('resolves to its owner and records the use', async () => {
    const created = await createMcpToken(ALICE, 'laptop')

    expect(await userFromMcpToken(created.token)).toBe(ALICE)

    const [row] = await db.select().from(mcpTokens)
    expect(row.lastUsedAt).not.toBeNull()
  })

  test('rejects a wrong secret, another token and a session-shaped value', async () => {
    const created = await createMcpToken(ALICE, 'laptop')
    const [id] = created.token.slice('mcp_'.length).split('.')

    expect(await userFromMcpToken(`mcp_${id}.wrong`)).toBeNull()
    expect(await userFromMcpToken('not-a-token')).toBeNull()
    expect(await userFromMcpToken(`${crypto.randomUUID()}.secret`)).toBeNull()
  })

  test('revoking is immediate and scoped to the owner', async () => {
    const mine = await createMcpToken(ALICE, 'laptop')
    const theirs = await createMcpToken(BOB, 'phone')

    expect(await revokeMcpToken(BOB, mine.id)).toBe(false)
    expect(await userFromMcpToken(mine.token)).toBe(ALICE)

    expect(await revokeMcpToken(ALICE, mine.id)).toBe(true)
    expect(await userFromMcpToken(mine.token)).toBeNull()
    expect(await userFromMcpToken(theirs.token)).toBe(BOB)
  })

  test('caps tokens per user without affecting the other account', async () => {
    for (let i = 0; i < 10; i += 1) {
      await createMcpToken(ALICE, `agent ${i}`)
    }

    await expect(createMcpToken(ALICE, 'one too many')).rejects.toThrow(
      'at most 10',
    )

    const created = await createMcpToken(BOB, 'still allowed')
    expect(await userFromMcpToken(created.token)).toBe(BOB)
  })
})
