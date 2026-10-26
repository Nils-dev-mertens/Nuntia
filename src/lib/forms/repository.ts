/**
 * Form storage.
 *
 * Drafts are editable; a published form is frozen, because the same prompt
 * answered across two weeks is only comparable if it never changed. Answers are
 * typed columns (`value_text`, `value_number`, `value_choices_json`) so counts
 * and averages are plain SQL on the results page and stable columns in a CSV.
 *
 * Every write goes through `withWriteLock`, like the rest of the app: SQLite has
 * exactly one writer, and a second deferred transaction that has already read
 * fails immediately rather than waiting.
 */

import { randomUUID } from 'node:crypto'

import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import {
  accounts,
  formAnswers,
  formAudience,
  formParticipation,
  formQuestions,
  formResponses,
  forms,
  users,
} from '#/db/schema.ts'
import type {
  Form,
  FormAudience,
  FormQuestion,
  FormStatus,
} from '#/db/schema.ts'
import { withWriteLock } from '#/lib/db/write-lock.ts'

import { buildFormCsv, tallyAnswers } from './results.ts'
import type { QuestionTally, ResultResponse } from './results.ts'
import { validateFormAnswers, validateFormDraft } from './validation.ts'
import type { FormQuestionView } from './validation.ts'

export type FormCounts = {
  /** People the form was sent to: every eligible user, or the selected list. */
  audience: number
  shown: number
  dismissed: number
  submitted: number
}

export type AdminForm = {
  id: string
  title: string
  description: string
  status: FormStatus
  audience: FormAudience
  audienceUserIds: string[]
  questions: FormQuestionView[]
  createdAt: Date
  publishedAt: Date | null
  closedAt: Date | null
  counts: FormCounts
}

export type AdminFormSummary = {
  id: string
  title: string
  status: FormStatus
  audience: FormAudience
  questionCount: number
  counts: FormCounts
  createdAt: Date
  publishedAt: Date | null
}

export type OpenForm = {
  id: string
  title: string
  description: string
  questionCount: number
  publishedAt: Date | null
  dismissed: boolean
  /** Answered, but the form is still open, so the answer can be changed. */
  submitted: boolean
}

export type FormResultsView = {
  id: string
  title: string
  status: FormStatus
  questions: FormQuestionView[]
  counts: FormCounts
  tallies: QuestionTally[]
  responses: ResultResponse[]
}

export type UserForm =
  | {
      state: 'open'
      title: string
      description: string
      questions: FormQuestionView[]
      /** True when this person has answered before and may edit that answer. */
      submitted: boolean
      answers: Array<{
        questionId: string
        text: string | null
        number: number | null
        choices: string[] | null
      }>
    }
  | { state: 'submitted'; title: string }
  | { state: 'closed'; title: string }
  | { state: 'unavailable'; title: null }

type ActionResult = { ok: true } | { ok: false; error: string }

function parseOptions(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((option): option is string => typeof option === 'string')
      : []
  } catch {
    return []
  }
}

function toQuestion(row: FormQuestion): FormQuestionView {
  return {
    id: row.id,
    key: row.key,
    position: row.position,
    type: row.type,
    prompt: row.prompt,
    help: row.help,
    required: row.required,
    options: parseOptions(row.options),
    scaleLowLabel: row.scaleLowLabel,
    scaleHighLabel: row.scaleHighLabel,
  }
}

async function loadQuestions(formId: string): Promise<FormQuestionView[]> {
  const rows = await db
    .select()
    .from(formQuestions)
    .where(eq(formQuestions.formId, formId))
    .orderBy(asc(formQuestions.position), asc(formQuestions.key))

  return rows.map(toQuestion)
}

async function hasMailbox(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .limit(1)

  return rows.length > 0
}

/** Everyone a form reaches: all mailed users, or the selected rows. */
async function isInAudience(form: Form, userId: string): Promise<boolean> {
  if (form.audience === 'selected') {
    const row = await db.query.formAudience.findFirst({
      where: and(
        eq(formAudience.formId, form.id),
        eq(formAudience.userId, userId),
      ),
    })
    return Boolean(row)
  }

  return hasMailbox(userId)
}

async function countEligibleUsers(): Promise<number> {
  const rows = await db
    .select({ userId: accounts.userId })
    .from(accounts)

  return new Set(
    rows
      .map((row) => row.userId)
      .filter((userId): userId is string => Boolean(userId)),
  ).size
}

async function countsFor(form: Form): Promise<FormCounts> {
  const [participationRows, responseRows] = await Promise.all([
    db.select().from(formParticipation).where(eq(formParticipation.formId, form.id)),
    db
      .select({ id: formResponses.id })
      .from(formResponses)
      .where(eq(formResponses.formId, form.id)),
  ])

  const audience =
    form.audience === 'selected'
      ? (
          await db
            .select({ userId: formAudience.userId })
            .from(formAudience)
            .where(eq(formAudience.formId, form.id))
        ).length
      : await countEligibleUsers()

  return {
    audience,
    shown: participationRows.filter((row) => row.shownAt !== null).length,
    dismissed: participationRows.filter((row) => row.dismissedAt !== null).length,
    submitted: responseRows.length,
  }
}

export async function listFormsForAdmin(): Promise<AdminFormSummary[]> {
  const formRows = await db.select().from(forms).orderBy(asc(forms.createdAt))
  if (formRows.length === 0) return []

  const ids = formRows.map((form) => form.id)
  const [questionRows, audienceRows, participationRows, responseRows, eligible] =
    await Promise.all([
      db
        .select({ formId: formQuestions.formId })
        .from(formQuestions)
        .where(inArray(formQuestions.formId, ids)),
      db
        .select({ formId: formAudience.formId })
        .from(formAudience)
        .where(inArray(formAudience.formId, ids)),
      db
        .select()
        .from(formParticipation)
        .where(inArray(formParticipation.formId, ids)),
      db
        .select({ formId: formResponses.formId })
        .from(formResponses)
        .where(inArray(formResponses.formId, ids)),
      countEligibleUsers(),
    ])

  const questions = new Map<string, number>()
  for (const row of questionRows) {
    questions.set(row.formId, (questions.get(row.formId) ?? 0) + 1)
  }

  const audience = new Map<string, number>()
  for (const row of audienceRows) {
    audience.set(row.formId, (audience.get(row.formId) ?? 0) + 1)
  }

  const participation = new Map<
    string,
    { shown: number; dismissed: number }
  >()
  for (const row of participationRows) {
    const entry = participation.get(row.formId) ?? { shown: 0, dismissed: 0 }
    if (row.shownAt) entry.shown += 1
    if (row.dismissedAt) entry.dismissed += 1
    participation.set(row.formId, entry)
  }

  const submitted = new Map<string, number>()
  for (const row of responseRows) {
    submitted.set(row.formId, (submitted.get(row.formId) ?? 0) + 1)
  }

  return formRows
    .slice()
    .reverse()
    .map((form) => ({
      id: form.id,
      title: form.title,
      status: form.status,
      audience: form.audience,
      questionCount: questions.get(form.id) ?? 0,
      counts: {
        audience: form.audience === 'selected' ? (audience.get(form.id) ?? 0) : eligible,
        shown: participation.get(form.id)?.shown ?? 0,
        dismissed: participation.get(form.id)?.dismissed ?? 0,
        submitted: submitted.get(form.id) ?? 0,
      },
      createdAt: form.createdAt,
      publishedAt: form.publishedAt,
    }))
}

export async function getFormForAdmin(formId: string): Promise<AdminForm | null> {
  const form = await db.query.forms.findFirst({ where: eq(forms.id, formId) })
  if (!form) return null

  const [questions, audienceRows, counts] = await Promise.all([
    loadQuestions(form.id),
    db
      .select({ userId: formAudience.userId })
      .from(formAudience)
      .where(eq(formAudience.formId, form.id)),
    countsFor(form),
  ])

  return {
    id: form.id,
    title: form.title,
    description: form.description,
    status: form.status,
    audience: form.audience,
    audienceUserIds: audienceRows.map((row) => row.userId),
    questions,
    createdAt: form.createdAt,
    publishedAt: form.publishedAt,
    closedAt: form.closedAt,
    counts,
  }
}

export async function listAudienceCandidates(): Promise<
  Array<{ id: string; name: string | null }>
> {
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .orderBy(asc(users.id))
}

export async function createFormDraft(createdBy: string): Promise<string> {
  const id = randomUUID()

  await db.insert(forms).values({
    id,
    title: 'Untitled form',
    description: '',
    status: 'draft',
    audience: 'all',
    createdBy,
  })

  return id
}

export async function saveFormDraft(
  formId: string,
  input: unknown,
): Promise<ActionResult> {
  const validated = validateFormDraft(input)
  if (!validated.ok) return { ok: false, error: validated.error }

  const form = await db.query.forms.findFirst({ where: eq(forms.id, formId) })
  if (!form) return { ok: false, error: 'That form no longer exists.' }
  if (form.status !== 'draft') {
    return {
      ok: false,
      error: 'A published form is frozen. Duplicate it to change the questions.',
    }
  }

  const draft = validated.value

  await withWriteLock(async () => {
    await db.transaction(async (tx) => {
      await tx
        .update(forms)
        .set({
          title: draft.title,
          description: draft.description,
          audience: draft.audience,
        })
        .where(eq(forms.id, formId))

      // A draft has no answers, so replacing the questions is safe and keeps
      // positions and keys consistent with what the operator just saw.
      await tx.delete(formQuestions).where(eq(formQuestions.formId, formId))
      await tx.delete(formAudience).where(eq(formAudience.formId, formId))

      await tx.insert(formQuestions).values(
        draft.questions.map((question, position) => ({
          id: randomUUID(),
          formId,
          key: `q${position + 1}`,
          position,
          type: question.type,
          prompt: question.prompt,
          help: question.help,
          required: question.required,
          options:
            question.options.length > 0 ? JSON.stringify(question.options) : null,
          scaleLowLabel: question.scaleLowLabel,
          scaleHighLabel: question.scaleHighLabel,
        })),
      )

      if (draft.audience === 'selected') {
        await tx.insert(formAudience).values(
          draft.audienceUserIds.map((userId) => ({ formId, userId })),
        )
      }
    })
  })

  return { ok: true }
}

export async function publishForm(formId: string): Promise<ActionResult> {
  const form = await db.query.forms.findFirst({ where: eq(forms.id, formId) })
  if (!form) return { ok: false, error: 'That form no longer exists.' }
  if (form.status !== 'draft') {
    return { ok: false, error: 'That form is not a draft.' }
  }

  const [questions, audienceRows] = await Promise.all([
    db
      .select({ id: formQuestions.id })
      .from(formQuestions)
      .where(eq(formQuestions.formId, formId)),
    db
      .select({ userId: formAudience.userId })
      .from(formAudience)
      .where(eq(formAudience.formId, formId)),
  ])

  if (questions.length === 0) {
    return { ok: false, error: 'Add at least one question before publishing.' }
  }
  if (form.audience === 'selected' && audienceRows.length === 0) {
    return { ok: false, error: 'Pick at least one person before publishing.' }
  }

  await db
    .update(forms)
    .set({ status: 'open', publishedAt: new Date() })
    .where(eq(forms.id, formId))

  return { ok: true }
}

export async function closeForm(formId: string): Promise<ActionResult> {
  const form = await db.query.forms.findFirst({ where: eq(forms.id, formId) })
  if (!form) return { ok: false, error: 'That form no longer exists.' }
  if (form.status !== 'open') {
    return { ok: false, error: 'That form is not open.' }
  }

  await db
    .update(forms)
    .set({ status: 'closed', closedAt: new Date() })
    .where(eq(forms.id, formId))

  return { ok: true }
}

export async function deleteDraft(formId: string): Promise<ActionResult> {
  const form = await db.query.forms.findFirst({ where: eq(forms.id, formId) })
  if (!form) return { ok: true }
  if (form.status !== 'draft') {
    return {
      ok: false,
      error: 'Only a draft can be deleted. Close a published form instead.',
    }
  }

  await db.delete(forms).where(eq(forms.id, formId))
  return { ok: true }
}

export async function duplicateForm(
  formId: string,
  createdBy: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const form = await db.query.forms.findFirst({ where: eq(forms.id, formId) })
  if (!form) return { ok: false, error: 'That form no longer exists.' }

  const [questions, audienceRows] = await Promise.all([
    loadQuestions(formId),
    db
      .select({ userId: formAudience.userId })
      .from(formAudience)
      .where(eq(formAudience.formId, formId)),
  ])

  const id = randomUUID()
  const title = `${form.title} (copy)`.slice(0, 140)

  await withWriteLock(async () => {
    await db.transaction(async (tx) => {
      await tx.insert(forms).values({
        id,
        title,
        description: form.description,
        status: 'draft',
        audience: form.audience,
        createdBy,
      })

      await tx.insert(formQuestions).values(
        questions.map((question, position) => ({
          id: randomUUID(),
          formId: id,
          key: question.key,
          position,
          type: question.type,
          prompt: question.prompt,
          help: question.help,
          required: question.required,
          options:
            question.options.length > 0 ? JSON.stringify(question.options) : null,
          scaleLowLabel: question.scaleLowLabel,
          scaleHighLabel: question.scaleHighLabel,
        })),
      )

      if (form.audience === 'selected' && audienceRows.length > 0) {
        await tx
          .insert(formAudience)
          .values(audienceRows.map((row) => ({ formId: id, userId: row.userId })))
      }
    })
  })

  return { ok: true, id }
}

export async function getFormResults(
  formId: string,
): Promise<FormResultsView | null> {
  const form = await db.query.forms.findFirst({ where: eq(forms.id, formId) })
  if (!form) return null

  const questions = await loadQuestions(formId)
  const [responseRows, answerRows, counts] = await Promise.all([
    db
      .select()
      .from(formResponses)
      .where(eq(formResponses.formId, formId))
      .orderBy(asc(formResponses.submittedAt)),
    db
      .select({
        responseId: formAnswers.responseId,
        questionId: formAnswers.questionId,
        valueText: formAnswers.valueText,
        valueNumber: formAnswers.valueNumber,
        valueChoices: formAnswers.valueChoices,
      })
      .from(formAnswers)
      .innerJoin(formResponses, eq(formResponses.id, formAnswers.responseId))
      .where(eq(formResponses.formId, formId)),
    countsFor(form),
  ])

  const answersByResponse = new Map<
    string,
    Array<{
      questionId: string
      text: string | null
      number: number | null
      choices: string[] | null
    }>
  >()

  for (const row of answerRows) {
    const list = answersByResponse.get(row.responseId) ?? []
    list.push({
      questionId: row.questionId,
      text: row.valueText,
      number: row.valueNumber,
      choices: parseOptions(row.valueChoices),
    })
    answersByResponse.set(row.responseId, list)
  }

  const responses: ResultResponse[] = responseRows.map((row) => ({
    userId: row.userId,
    submittedAt: row.submittedAt,
    updatedAt: row.updatedAt,
    answers: answersByResponse.get(row.id) ?? [],
  }))

  return {
    id: form.id,
    title: form.title,
    status: form.status,
    questions,
    counts,
    tallies: tallyAnswers(questions, responses),
    responses,
  }
}

export async function getFormCsv(
  formId: string,
): Promise<{ filename: string; csv: string } | null> {
  const results = await getFormResults(formId)
  if (!results) return null

  return buildFormCsv({
    title: results.title,
    questions: results.questions,
    responses: results.responses,
  })
}

/** Open, unsubmitted forms for one person. Dismissed rows are still listed. */
export async function listOpenFormsForUser(userId: string): Promise<OpenForm[]> {
  const formRows = await db
    .select({ form: forms, audienceUserId: formAudience.userId })
    .from(forms)
    .leftJoin(
      formAudience,
      and(eq(formAudience.formId, forms.id), eq(formAudience.userId, userId)),
    )
    .where(eq(forms.status, 'open'))

  const mailbox = await hasMailbox(userId)
  const eligible = formRows
    .map((row) => row.form)
    .filter((form) =>
      form.audience === 'selected' ? true : mailbox,
    )
    .filter((form) => {
      if (form.audience === 'all') return true
      return formRows.some(
        (row) => row.form.id === form.id && row.audienceUserId === userId,
      )
    })

  if (eligible.length === 0) return []

  const ids = eligible.map((form) => form.id)
  const [participationRows, questionRows] = await Promise.all([
    db
      .select()
      .from(formParticipation)
      .where(
        and(
          eq(formParticipation.userId, userId),
          inArray(formParticipation.formId, ids),
        ),
      ),
    db
      .select({ formId: formQuestions.formId })
      .from(formQuestions)
      .where(inArray(formQuestions.formId, ids)),
  ])

  const participation = new Map(
    participationRows.map((row) => [row.formId, row]),
  )
  const questionCounts = new Map<string, number>()
  for (const row of questionRows) {
    questionCounts.set(row.formId, (questionCounts.get(row.formId) ?? 0) + 1)
  }

  return eligible
    .map((form) => ({
      id: form.id,
      title: form.title,
      description: form.description,
      questionCount: questionCounts.get(form.id) ?? 0,
      publishedAt: form.publishedAt,
      dismissed: Boolean(participation.get(form.id)?.dismissedAt),
      submitted: Boolean(participation.get(form.id)?.submittedAt),
    }))
    .sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    )
}

/** The one form the inbox banner promotes: newest, unsubmitted, not dismissed. */
export async function promotedFormForUser(
  userId: string,
): Promise<OpenForm | null> {
  const open = await listOpenFormsForUser(userId)
  return open.find((form) => !form.dismissed && !form.submitted) ?? null
}

export async function markFormShown(
  formId: string,
  userId: string,
): Promise<void> {
  await withWriteLock(async () => {
    const existing = await db.query.formParticipation.findFirst({
      where: and(
        eq(formParticipation.formId, formId),
        eq(formParticipation.userId, userId),
      ),
    })

    if (!existing) {
      await db.insert(formParticipation).values({
        formId,
        userId,
        shownAt: new Date(),
      })
      return
    }

    if (!existing.shownAt) {
      await db
        .update(formParticipation)
        .set({ shownAt: new Date() })
        .where(
          and(
            eq(formParticipation.formId, formId),
            eq(formParticipation.userId, userId),
            isNull(formParticipation.shownAt),
          ),
        )
    }
  })
}

export async function getFormForUser(
  formId: string,
  userId: string,
): Promise<UserForm> {
  const form = await db.query.forms.findFirst({ where: eq(forms.id, formId) })
  if (!form || form.status === 'draft') {
    return { state: 'unavailable', title: null }
  }

  const participation = await db.query.formParticipation.findFirst({
    where: and(
      eq(formParticipation.formId, formId),
      eq(formParticipation.userId, userId),
    ),
  })

  if (!(await isInAudience(form, userId))) {
    return { state: 'unavailable', title: null }
  }
  if (form.status === 'closed') {
    return participation?.submittedAt
      ? { state: 'submitted', title: form.title }
      : { state: 'closed', title: form.title }
  }

  const questions = await loadQuestions(formId)
  if (questions.length === 0) {
    return { state: 'unavailable', title: null }
  }

  const existing = participation?.submittedAt
    ? await db.query.formResponses.findFirst({
        where: and(
          eq(formResponses.formId, formId),
          eq(formResponses.userId, userId),
        ),
      })
    : undefined

  const answers = existing
    ? (
        await db
          .select()
          .from(formAnswers)
          .where(eq(formAnswers.responseId, existing.id))
      ).map((answer) => ({
        questionId: answer.questionId,
        text: answer.valueText,
        number: answer.valueNumber,
        choices: parseOptions(answer.valueChoices),
      }))
    : []

  return {
    state: 'open',
    title: form.title,
    description: form.description,
    questions,
    submitted: Boolean(existing),
    answers,
  }
}

export async function dismissForm(
  formId: string,
  userId: string,
): Promise<ActionResult> {
  const form = await db.query.forms.findFirst({ where: eq(forms.id, formId) })
  if (!form || form.status !== 'open') {
    return { ok: false, error: 'That form is no longer open.' }
  }
  if (!(await isInAudience(form, userId))) {
    return { ok: false, error: 'That form is not available to you.' }
  }

  const now = new Date()

  await withWriteLock(async () => {
    const existing = await db.query.formParticipation.findFirst({
      where: and(
        eq(formParticipation.formId, formId),
        eq(formParticipation.userId, userId),
      ),
    })

    if (!existing) {
      await db.insert(formParticipation).values({
        formId,
        userId,
        shownAt: now,
        dismissedAt: now,
      })
      return
    }

    await db
      .update(formParticipation)
      .set({
        shownAt: existing.shownAt ?? now,
        dismissedAt: existing.dismissedAt ?? now,
      })
      .where(
        and(
          eq(formParticipation.formId, formId),
          eq(formParticipation.userId, userId),
        ),
      )
  })

  return { ok: true }
}

export async function submitForm(
  formId: string,
  userId: string,
  input: unknown,
): Promise<ActionResult> {
  const form = await db.query.forms.findFirst({ where: eq(forms.id, formId) })
  if (!form) return { ok: false, error: 'That form no longer exists.' }
  if (form.status !== 'open') {
    return { ok: false, error: 'This form is no longer accepting answers.' }
  }
  if (!(await isInAudience(form, userId))) {
    return { ok: false, error: 'This form is not available to you.' }
  }

  const questions = await loadQuestions(formId)
  const validated = validateFormAnswers(questions, input)
  if (!validated.ok) return { ok: false, error: validated.error }

  const answers = validated.value
  const now = new Date()

  await withWriteLock(async () => {
    await db.transaction(async (tx) => {
      const existing = await tx.query.formResponses.findFirst({
        where: and(
          eq(formResponses.formId, formId),
          eq(formResponses.userId, userId),
        ),
      })

      const responseId = existing?.id ?? randomUUID()

      if (existing) {
        await tx
          .update(formResponses)
          .set({ updatedAt: now })
          .where(eq(formResponses.id, responseId))
        await tx.delete(formAnswers).where(eq(formAnswers.responseId, responseId))
      } else {
        await tx.insert(formResponses).values({
          id: responseId,
          formId,
          userId,
          submittedAt: now,
          updatedAt: now,
        })
      }

      if (answers.length > 0) {
        await tx.insert(formAnswers).values(
          answers.map((answer) => ({
            id: randomUUID(),
            responseId,
            questionId: answer.questionId,
            valueText: answer.text,
            valueNumber: answer.number,
            valueChoices: answer.choices ? JSON.stringify(answer.choices) : null,
          })),
        )
      }

      const participation = await tx.query.formParticipation.findFirst({
        where: and(
          eq(formParticipation.formId, formId),
          eq(formParticipation.userId, userId),
        ),
      })

      if (!participation) {
        await tx.insert(formParticipation).values({
          formId,
          userId,
          shownAt: now,
          submittedAt: now,
        })
      } else {
        await tx
          .update(formParticipation)
          .set({ submittedAt: now, shownAt: participation.shownAt ?? now })
          .where(
            and(
              eq(formParticipation.formId, formId),
              eq(formParticipation.userId, userId),
            ),
          )
      }
    })
  })

  return { ok: true }
}
