/**
 * Form storage.
 *
 * The rules worth testing are the ones that protect the answers: a published
 * form cannot be edited, a form reaches only its audience, one person produces
 * one response however often they submit, and a dismissal hides the banner
 * without losing the form. A draft has no answers, which is why replacing its
 * questions is allowed and replacing a published one is not.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'nuntia-forms-test-'))
const originalDbUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = `file:${join(tmpDir, 'test.db')}`

const { db, initDatabase } = await import('#/db/index.ts')
const {
  accounts,
  formAnswers,
  formAudience,
  formParticipation,
  formQuestions,
  formResponses,
  forms,
  users,
} = await import('#/db/schema.ts')
const {
  closeForm,
  createFormDraft,
  deleteDraft,
  dismissForm,
  duplicateForm,
  getFormForAdmin,
  getFormForUser,
  getFormResults,
  listOpenFormsForUser,
  promotedFormForUser,
  publishForm,
  saveFormDraft,
  submitForm,
} = await import('#/lib/forms/repository.ts')
const { migrate } = await import('drizzle-orm/libsql/migrator')

await initDatabase()
await migrate(db, { migrationsFolder: './drizzle' })

const ADA = 'ada@example.com'
const BOB = 'bob@example.com'
const CY = 'cy@example.com'

const draft = {
  title: 'Saved replies',
  description: 'A few questions about a feature that does not exist yet.',
  audience: 'all' as const,
  questions: [
    {
      type: 'short-text' as const,
      prompt: 'What would you save?',
      required: true,
    },
    {
      type: 'choice' as const,
      prompt: 'Where would it live?',
      options: ['Composer', 'Inbox'],
      required: true,
    },
    {
      type: 'scale' as const,
      prompt: 'How useful would it be?',
      scaleLowLabel: 'Not useful',
      scaleHighLabel: 'Daily',
    },
  ],
}

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDbUrl
})

beforeEach(async () => {
  await db.delete(formAnswers)
  await db.delete(formResponses)
  await db.delete(formParticipation)
  await db.delete(formAudience)
  await db.delete(formQuestions)
  await db.delete(forms)
  await db.delete(accounts)
  await db.delete(users)

  await db.insert(users).values(
    [ADA, BOB, CY].map((id) => ({
      id,
      email: id,
      passwordHash: '$argon2id$test-only',
    })),
  )

  // Ada and Bob have a mailbox; Cy was invited but never connected one.
  for (const id of [ADA, BOB]) {
    await db.insert(accounts).values({
      id,
      email: id,
      userId: id,
      refreshTokenEncrypted: 'v1:a:b:c',
    })
  }
})

async function saveDraft(input: unknown = draft): Promise<string> {
  const id = await createFormDraft(ADA)
  const saved = await saveFormDraft(id, input)
  expect(saved.ok).toBe(true)
  return id
}

async function published(input: unknown = draft): Promise<string> {
  const id = await saveDraft(input)
  const result = await publishForm(id)
  expect(result.ok).toBe(true)
  return id
}

async function answersFor(
  formId: string,
  text = 'A saved reply',
): Promise<Array<{ questionId: string; text: string }>> {
  const form = await getFormForAdmin(formId)
  if (!form) throw new Error('form missing')

  return form.questions
    .filter((question) => question.type === 'short-text' || question.type === 'choice')
    .map((question) => ({
      questionId: question.id,
      text: question.type === 'choice' ? 'Composer' : text,
    }))
}

describe('drafts', () => {
  test('save questions in order with their options and scale labels', async () => {
    const id = await saveDraft()
    const form = await getFormForAdmin(id)

    expect(form?.status).toBe('draft')
    expect(form?.audience).toBe('all')
    expect(form?.questions.map((question) => question.prompt)).toEqual([
      'What would you save?',
      'Where would it live?',
      'How useful would it be?',
    ])
    expect(form?.questions[1].options).toEqual(['Composer', 'Inbox'])
    expect(form?.questions[2].scaleHighLabel).toBe('Daily')
    expect(form?.questions[0].required).toBe(true)
  })

  test('an invalid save leaves the stored draft untouched', async () => {
    const id = await saveDraft()
    const rejected = await saveFormDraft(id, { ...draft, title: '   ' })

    expect(rejected.ok).toBe(false)
    const form = await getFormForAdmin(id)
    expect(form?.title).toBe('Saved replies')
    expect(form?.questions).toHaveLength(3)
  })

  test('replacing a draft’s questions is allowed and keeps positions', async () => {
    const id = await saveDraft()
    const saved = await saveFormDraft(id, {
      ...draft,
      questions: [{ type: 'yes-no', prompt: 'Would you use it?' }],
    })

    expect(saved.ok).toBe(true)
    const form = await getFormForAdmin(id)
    expect(form?.questions).toHaveLength(1)
    expect(form?.questions[0].type).toBe('yes-no')
  })
})

describe('publishing', () => {
  test('publishes once, then refuses edits', async () => {
    const id = await published()
    const form = await getFormForAdmin(id)

    expect(form?.status).toBe('open')
    expect(form?.publishedAt).not.toBeNull()

    const edit = await saveFormDraft(id, { ...draft, title: 'Changed' })
    expect(edit.ok).toBe(false)
    if (!edit.ok) expect(edit.error).toContain('frozen')

    const again = await publishForm(id)
    expect(again.ok).toBe(false)
  })

  test('closing is one-way and leaves the answers readable', async () => {
    const id = await published()
    const result = await closeForm(id)

    expect(result.ok).toBe(true)
    expect((await getFormForAdmin(id))?.status).toBe('closed')
    expect((await closeForm(id)).ok).toBe(false)
  })

  test('a selected audience must not be empty', async () => {
    const id = await createFormDraft(ADA)
    const saved = await saveFormDraft(id, {
      ...draft,
      audience: 'selected',
      audienceUserIds: [],
    })
    expect(saved.ok).toBe(false)
  })
})

describe('audience', () => {
  test('everyone means everyone with a mailbox', async () => {
    const id = await published()

    expect(await listOpenFormsForUser(ADA)).toHaveLength(1)
    expect(await listOpenFormsForUser(BOB)).toHaveLength(1)
    expect(await listOpenFormsForUser(CY)).toHaveLength(0)

    const form = await getFormForAdmin(id)
    expect(form?.counts.audience).toBe(2)
  })

  test('a selected form reaches only the people named', async () => {
    const id = await published({
      ...draft,
      audience: 'selected',
      audienceUserIds: [BOB],
    })

    expect(await listOpenFormsForUser(ADA)).toHaveLength(0)
    expect(await listOpenFormsForUser(BOB)).toHaveLength(1)

    const form = await getFormForAdmin(id)
    expect(form?.counts.audience).toBe(1)
  })

  test('someone outside the audience cannot open or answer it', async () => {
    const id = await published({
      ...draft,
      audience: 'selected',
      audienceUserIds: [BOB],
    })

    expect((await getFormForUser(id, ADA)).state).toBe('unavailable')

    const submitted = await submitForm(id, ADA, await answersFor(id))
    expect(submitted.ok).toBe(false)
  })
})

describe('the banner', () => {
  test('promotes one form and a dismissal only hides the banner', async () => {
    const id = await published()

    const promoted = await promotedFormForUser(ADA)
    expect(promoted?.id).toBe(id)

    const dismissed = await dismissForm(id, ADA)
    expect(dismissed.ok).toBe(true)

    expect(await promotedFormForUser(ADA)).toBeNull()

    const listed = await listOpenFormsForUser(ADA)
    expect(listed).toHaveLength(1)
    expect(listed[0].dismissed).toBe(true)
  })

  test('submitting a form clears the banner but keeps it editable in the list', async () => {
    const id = await published()
    const result = await submitForm(id, ADA, await answersFor(id))

    expect(result.ok).toBe(true)
    expect(await promotedFormForUser(ADA)).toBeNull()

    const listed = await listOpenFormsForUser(ADA)
    expect(listed).toHaveLength(1)
    expect(listed[0].submitted).toBe(true)
    expect((await getFormForAdmin(id))?.counts.submitted).toBe(1)
  })
})

describe('answers', () => {
  test('a missing required answer writes nothing', async () => {
    const id = await published()
    const form = await getFormForAdmin(id)
    if (!form) throw new Error('form missing')

    const result = await submitForm(id, ADA, [
      { questionId: form.questions[1].id, text: 'Composer' },
    ])

    expect(result.ok).toBe(false)
    expect((await getFormResults(id))?.responses).toHaveLength(0)
  })

  test('one person, one response: a second submission updates it', async () => {
    const id = await published()

    expect((await submitForm(id, ADA, await answersFor(id, 'First'))).ok).toBe(true)
    expect((await submitForm(id, ADA, await answersFor(id, 'Second'))).ok).toBe(true)

    const results = await getFormResults(id)
    expect(results?.responses).toHaveLength(1)
    expect(results?.counts.submitted).toBe(1)

    const text = results?.responses[0].answers.find((answer) => answer.text === 'Second')
    expect(text).toBeDefined()

    const counts = results?.tallies[1].counts
    expect(counts).toEqual([
      { option: 'Composer', count: 1 },
      { option: 'Inbox', count: 0 },
    ])
  })

  test('a closed form refuses answers', async () => {
    const id = await published()
    await closeForm(id)

    const result = await submitForm(id, BOB, await answersFor(id))
    expect(result.ok).toBe(false)
    expect((await getFormForUser(id, BOB)).state).toBe('closed')
  })

  test('an answered form stays editable while it is open, then reads as submitted', async () => {
    const id = await published()
    await submitForm(id, ADA, await answersFor(id, 'First answer'))

    const editable = await getFormForUser(id, ADA)
    expect(editable.state).toBe('open')
    if (editable.state !== 'open') return
    expect(editable.submitted).toBe(true)
    expect(
      editable.answers.some((answer) => answer.text === 'First answer'),
    ).toBe(true)

    await closeForm(id)
    expect((await getFormForUser(id, ADA)).state).toBe('submitted')
  })
})

describe('lifecycle', () => {
  test('duplicating a published form produces a fresh draft', async () => {
    const id = await published()
    const copy = await duplicateForm(id, ADA)

    expect(copy.ok).toBe(true)
    if (!copy.ok) return

    const form = await getFormForAdmin(copy.id)
    expect(form?.status).toBe('draft')
    expect(form?.questions).toHaveLength(3)
    expect(form?.title).toBe('Saved replies (copy)')

    // The original keeps its answers and stays open.
    expect((await getFormForAdmin(id))?.status).toBe('open')

    expect((await deleteDraft(copy.id)).ok).toBe(true)
  })

  test('a published form cannot be deleted', async () => {
    const id = await published()
    const result = await deleteDraft(id)
    expect(result.ok).toBe(false)
    expect(await getFormForAdmin(id)).not.toBeNull()
  })
})
