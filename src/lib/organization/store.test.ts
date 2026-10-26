import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrganizationRule } from './matching.ts'
import { defaultStateLabels } from './labels.ts'
import type { StateLabels } from './labels.ts'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-organization-rules-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const { accounts, CONVERSATION_STATES, organizationRules, stateLabels, users } =
  await import('#/db/schema.ts')
const { listOrganizationRules, saveOrganizationRules, listStateLabels, saveStateLabels } =
  await import('./store.ts')

await initDatabase()

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(stateLabels)
  await db.delete(organizationRules)
  await db.delete(accounts)
  await db.delete(users)
  for (const email of ['alice@example.com', 'bob@example.com']) {
    await db.insert(users).values({
      id: email,
      email,
      passwordHash: '$argon2id$v=19$m=1$s$h',
    })
  }
})

describe('organization rule persistence', () => {
  test('persists rule order and isolates rules by signed-in user', async () => {
    const rules = [
      {
        id: 'first',
        name: 'Finance',
        description: 'Invoices and payments',
        field: 'sender-domain',
        value: 'ACME.example',
        enabled: true,
      },
      {
        id: 'second',
        name: 'Invoices',
        description: '',
        field: 'subject-contains',
        value: 'Invoice',
        enabled: false,
      },
    ] as const

    expect(await saveOrganizationRules('Alice@Example.com', [...rules])).toEqual([
      { ...rules[0], value: 'acme.example' },
      rules[1],
    ])
    expect(await listOrganizationRules('alice@example.com')).toEqual([
      { ...rules[0], value: 'acme.example' },
      rules[1],
    ])
    expect(await listOrganizationRules('bob@example.com')).toEqual([])
  })

  test('invalid replacement does not delete previously saved rules', async () => {
    const valid: OrganizationRule[] = [
      {
        id: 'kept',
        name: 'Work',
        description: 'Things from work',
        field: 'sender-domain',
        value: 'example.com',
        enabled: true,
      },
    ]
    await saveOrganizationRules('alice@example.com', valid)

    expect(
      await saveOrganizationRules('alice@example.com', [
        { ...valid[0], field: 'invalid' } as unknown as OrganizationRule,
      ]),
    ).toBeNull()
    expect(await listOrganizationRules('alice@example.com')).toEqual(valid)
  })

  test('an empty list clears only that user’s rules', async () => {
    const rule = {
      id: 'alice-rule',
      name: 'Work',
      description: '',
      field: 'sender-domain',
      value: 'example.com',
      enabled: true,
    }
    await saveOrganizationRules('alice@example.com', [rule])
    await saveOrganizationRules('bob@example.com', [
      { ...rule, id: 'bob-rule', name: 'Personal' },
    ])

    await saveOrganizationRules('alice@example.com', [])
    expect(await listOrganizationRules('alice@example.com')).toEqual([])
    expect((await listOrganizationRules('bob@example.com'))[0]?.name).toBe(
      'Personal',
    )
  })
})

describe('state label persistence', () => {
  function submission(labels: StateLabels) {
    return CONVERSATION_STATES.map((state) => ({ state, ...labels[state] }))
  }

  test('reads as the defaults until the user edits a label', async () => {
    expect(await listStateLabels('alice@example.com')).toEqual(
      defaultStateLabels(),
    )
  })

  test('keeps the user’s wording and isolates it by signed-in user', async () => {
    const labels = defaultStateLabels()
    labels['needs-action'] = {
      name: 'Do this now',
      description: 'Mail you are the one who has to answer.',
    }
    labels.informational.description = ''

    expect(await saveStateLabels('Alice@Example.com', submission(labels))).toEqual(
      labels,
    )
    expect(await listStateLabels('alice@example.com')).toEqual(labels)
    expect(await listStateLabels('bob@example.com')).toEqual(
      defaultStateLabels(),
    )
  })

  test('saving the defaults clears every stored override', async () => {
    const labels = defaultStateLabels()
    labels['waiting-for-reply'] = {
      name: 'Ball with them',
      description: 'You replied and the next move is theirs.',
    }
    await saveStateLabels('alice@example.com', submission(labels))

    const rowsBefore = await listStateLabels('alice@example.com')
    expect(rowsBefore['waiting-for-reply'].name).toBe('Ball with them')

    await saveStateLabels(
      'alice@example.com',
      submission(defaultStateLabels()),
    )
    expect(await listStateLabels('alice@example.com')).toEqual(
      defaultStateLabels(),
    )
  })

  test('invalid labels leave the previously saved wording in place', async () => {
    const labels = defaultStateLabels()
    labels.informational = {
      name: 'FYI',
      description: 'No answer needed.',
    }
    await saveStateLabels('alice@example.com', submission(labels))

    expect(
      await saveStateLabels('alice@example.com', [
        { state: 'needs-action', name: '   ', description: '' },
      ]),
    ).toBeNull()
    expect((await listStateLabels('alice@example.com')).informational.name).toBe(
      'FYI',
    )
  })
})
