import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-team-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const { teamMembers, users } = await import('#/db/schema.ts')
const { listTeamMembers, removeTeamMember, saveTeamMember } = await import(
  './store.ts'
)

await initDatabase()

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(teamMembers)
  await db.delete(users)
  for (const email of ['alice@example.com', 'bob@example.com']) {
    await db.insert(users).values({
      id: email,
      email,
      passwordHash: '$argon2id$v=19$m=1$s$h',
    })
  }
})

describe('team directory', () => {
  test('adds, edits and removes a member, scoped to the owner', async () => {
    const added = await saveTeamMember('Alice@Example.com', {
      id: null,
      name: ' Sarah Jones ',
      email: ' SARAH@Example.com ',
      role: ' Billing ',
    })

    expect(added.error).toBeNull()
    if (!added.member) throw new Error('expected a member')
    expect(added.member).toMatchObject({
      name: 'Sarah Jones',
      email: 'sarah@example.com',
      role: 'Billing',
    })

    expect(await listTeamMembers('alice@example.com')).toEqual([added.member])

    const updated = await saveTeamMember('alice@example.com', {
      id: added.member.id,
      name: 'Sarah J.',
      email: 'sarah@example.com',
      role: '',
    })
    expect(updated.error).toBeNull()
    expect(updated.member).toMatchObject({ name: 'Sarah J.', role: null })

    // Another user cannot see or remove Alice's colleague.
    expect(await listTeamMembers('bob@example.com')).toEqual([])
    expect(await removeTeamMember('bob@example.com', added.member.id)).toBe(
      false,
    )
    expect(await removeTeamMember('alice@example.com', added.member.id)).toBe(
      true,
    )
    expect(await listTeamMembers('alice@example.com')).toEqual([])
  })

  test('refuses a duplicate address instead of silently overwriting', async () => {
    await saveTeamMember('alice@example.com', {
      id: null,
      name: 'Sarah Jones',
      email: 'sarah@example.com',
      role: 'Billing',
    })

    const duplicate = await saveTeamMember('alice@example.com', {
      id: null,
      name: 'Someone Else',
      email: 'SARAH@example.com',
      role: '',
    })

    expect(duplicate.member).toBeNull()
    expect(duplicate.error).toContain('already on your team')
  })

  test('rejects input the picker could not use', async () => {
    for (const input of [
      { id: null, name: '', email: 'sarah@example.com', role: '' },
      { id: null, name: 'Sarah', email: 'not-an-address', role: '' },
      { id: null, name: 'Sarah', email: 'sarah@example.com', role: 'x'.repeat(201) },
    ]) {
      const result = await saveTeamMember('alice@example.com', input)
      expect(result.member).toBeNull()
      expect(result.error).not.toBeNull()
    }

    expect(await listTeamMembers('alice@example.com')).toEqual([])
  })
})
