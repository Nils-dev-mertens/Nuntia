import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrganizationLabel } from './matching.ts'
import { defaultStateLabels } from './labels.ts'
import type { StateLabels } from './labels.ts'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-organization-rules-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const {
  accounts,
  CONVERSATION_STATES,
  organizationLabels,
  organizationRules,
  stateLabels,
  users,
} = await import('#/db/schema.ts')
const {
  listMeaningLabels,
  listOrganizationLabels,
  saveOrganizationLabels,
  listStateLabels,
  saveStateLabels,
} = await import('./store.ts')

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
  await db.delete(organizationLabels)
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

function label(overrides: Partial<OrganizationLabel> = {}): OrganizationLabel {
  return {
    id: 'first',
    name: 'Finance',
    description: 'Invoices and payments',
    enabled: true,
    rules: [],
    ...overrides,
  }
}

describe('custom label persistence', () => {
  test('persists order, conditions and isolation between users', async () => {
    const labels: OrganizationLabel[] = [
      label({
        rules: [
          { id: 'rule-a', field: 'sender-domain', value: 'ACME.example' },
        ],
      }),
      label({
        id: 'second',
        name: 'Invoices',
        description: '',
        enabled: false,
        rules: [{ id: 'rule-b', field: 'subject-contains', value: 'Invoice' }],
      }),
    ]

    const expected: OrganizationLabel[] = [
      label({
        rules: [
          { id: 'rule-a', field: 'sender-domain', value: 'acme.example' },
        ],
      }),
      labels[1],
    ]

    expect(await saveOrganizationLabels('Alice@Example.com', labels)).toEqual(
      expected,
    )
    expect(await listOrganizationLabels('alice@example.com')).toEqual(expected)
    expect(await listOrganizationLabels('bob@example.com')).toEqual([])
  })

  test('keeps every condition a label carries', async () => {
    await saveOrganizationLabels('alice@example.com', [
      label({
        rules: [
          { id: 'rule-a', field: 'sender-domain', value: 'stripe.example' },
          { id: 'rule-b', field: 'subject-contains', value: 'invoice' },
        ],
      }),
    ])

    const [stored] = await listOrganizationLabels('alice@example.com')
    expect(stored.rules.map((rule) => rule.field)).toEqual([
      'sender-domain',
      'subject-contains',
    ])
  })

  test('invalid replacement does not delete previously saved labels', async () => {
    const valid: OrganizationLabel[] = [label()]

    await saveOrganizationLabels('alice@example.com', valid)

    expect(
      await saveOrganizationLabels('alice@example.com', [
        {
          ...valid[0],
          rules: [{ id: 'r', field: 'invalid', value: 'x' }],
        } as unknown as OrganizationLabel,
      ]),
    ).toBeNull()
    expect(await listOrganizationLabels('alice@example.com')).toEqual(valid)
  })

  test('an empty list clears only that user’s labels', async () => {
    await saveOrganizationLabels('alice@example.com', [label({ id: 'alice' })])
    await saveOrganizationLabels('bob@example.com', [
      label({ id: 'bob', name: 'Personal' }),
    ])

    await saveOrganizationLabels('alice@example.com', [])
    expect(await listOrganizationLabels('alice@example.com')).toEqual([])
    expect((await listOrganizationLabels('bob@example.com'))[0]?.name).toBe(
      'Personal',
    )
  })
})

describe('the labels the decision model may use', () => {
  test('are the enabled ones that carry no condition', async () => {
    await saveOrganizationLabels('alice@example.com', [
      label({ id: 'by-meaning', description: 'Invoices I still have to pay.' }),      label({
        id: 'by-rule',
        name: 'Northwind',
        description: 'A correspondent',
        rules: [
          { id: 'rule-a', field: 'sender-domain', value: 'northwind.example' },
        ],
      }),
      label({ id: 'disabled', description: 'Off for now', enabled: false }),
    ])

    expect(
      (await listMeaningLabels('alice@example.com')).map((entry) => entry.id),
    ).toEqual(['by-meaning'])
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
