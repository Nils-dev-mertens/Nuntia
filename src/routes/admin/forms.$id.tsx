/**
 * `/admin/forms/<id>` — write a form, publish it, read the answers.
 *
 * A draft is editable and a published form is not; that is the whole reason the
 * page can be both a builder and a results view without a version column. The
 * preview renders through the same `FormFields` component the person answering
 * sees, so a broken question is visible before it is sent.
 */

import { createServerFn } from '@tanstack/react-start'
import {
  Link,
  createFileRoute,
  notFound,
  useRouter,
} from '@tanstack/react-router'
import { useState } from 'react'

import { currentOperator } from '#/lib/admin/guard.ts'
import {
  closeForm,
  deleteDraft,
  duplicateForm,
  getFormCsv,
  getFormForAdmin,
  getFormResults,
  listAudienceCandidates,
  publishForm,
  saveFormDraft,
} from '#/lib/forms/repository.ts'
import type {
  AdminForm,
  FormResultsView,
} from '#/lib/forms/repository.ts'
import { FORM_LIMITS, FORM_SCALE_VALUES } from '#/lib/forms/validation.ts'
import type { FormQuestionView } from '#/lib/forms/validation.ts'
import { FormFields } from '#/components/form-fields.tsx'
import { FORM_QUESTION_TYPES } from '#/db/schema.ts'
import type { FormQuestionType } from '#/db/schema.ts'

const QUESTION_TYPE_LABELS: Record<FormQuestionType, string> = {
  'short-text': 'Short text',
  'long-text': 'Long text',
  choice: 'One choice',
  'multi-choice': 'Multiple choices',
  scale: 'Scale 1–5',
  'yes-no': 'Yes / no',
}

type Person = { id: string; name: string | null }

const loadFormPage = createServerFn({ method: 'GET' })
  .validator((data: { id: string }) => data)
  .handler(
    async ({
      data,
    }): Promise<
      | { allowed: false }
      | {
          allowed: true
          form: AdminForm
          results: FormResultsView | null
          people: Person[]
        }
    > => {
      const operator = await currentOperator()
      if (!operator) return { allowed: false }

      const form = await getFormForAdmin(data.id)
      if (!form) return { allowed: false }

      const [results, people] = await Promise.all([
        getFormResults(data.id),
        listAudienceCandidates(),
      ])

      return { allowed: true, form, results, people }
    },
  )

const saveAction = createServerFn({ method: 'POST' })
  .validator((data: { id: string; draft: unknown }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const operator = await currentOperator()
    if (!operator) return { error: 'Not found.' }

    const result = await saveFormDraft(data.id, data.draft)
    return { error: result.ok ? null : result.error }
  })

const publishAction = createServerFn({ method: 'POST' })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const operator = await currentOperator()
    if (!operator) return { error: 'Not found.' }

    const result = await publishForm(data.id)
    return { error: result.ok ? null : result.error }
  })

const closeAction = createServerFn({ method: 'POST' })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const operator = await currentOperator()
    if (!operator) return { error: 'Not found.' }

    const result = await closeForm(data.id)
    return { error: result.ok ? null : result.error }
  })

const duplicateAction = createServerFn({ method: 'POST' })
  .validator((data: { id: string }) => data)
  .handler(
    async ({ data }): Promise<{ error: string | null; id: string | null }> => {
      const operator = await currentOperator()
      if (!operator) return { error: 'Not found.', id: null }

      const result = await duplicateForm(data.id, operator.userId)
      return result.ok
        ? { error: null, id: result.id }
        : { error: result.error, id: null }
    },
  )

const deleteAction = createServerFn({ method: 'POST' })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const operator = await currentOperator()
    if (!operator) return { error: 'Not found.' }

    const result = await deleteDraft(data.id)
    return { error: result.ok ? null : result.error }
  })

const csvAction = createServerFn({ method: 'POST' })
  .validator((data: { id: string }) => data)
  .handler(
    async ({
      data,
    }): Promise<{
      error: string | null
      filename: string | null
      csv: string | null
    }> => {
      const operator = await currentOperator()
      if (!operator) return { error: 'Not found.', filename: null, csv: null }

      const file = await getFormCsv(data.id)
      if (!file) return { error: 'That form no longer exists.', filename: null, csv: null }

      return { error: null, filename: file.filename, csv: file.csv }
    },
  )

export const Route = createFileRoute('/admin/forms/$id')({
  loader: async ({ params }) => {
    const state = await loadFormPage({ data: { id: params.id } })
    if (!state.allowed) throw notFound()

    return { form: state.form, results: state.results, people: state.people }
  },
  component: FormBuilderPage,
})

type DraftQuestion = {
  type: FormQuestionType
  prompt: string
  help: string
  required: boolean
  options: string[]
  scaleLowLabel: string
  scaleHighLabel: string
}

function toDraftQuestion(question: FormQuestionView): DraftQuestion {
  return {
    type: question.type,
    prompt: question.prompt,
    help: question.help ?? '',
    required: question.required,
    options: question.options.length > 0 ? question.options : ['', ''],
    scaleLowLabel: question.scaleLowLabel ?? '',
    scaleHighLabel: question.scaleHighLabel ?? '',
  }
}

function FormBuilderPage() {
  const { form, results, people } = Route.useLoaderData()
  const { id } = Route.useParams()
  const router = useRouter()

  const readOnly = form.status !== 'draft'

  const [title, setTitle] = useState(form.title)
  const [description, setDescription] = useState(form.description)
  const [audience, setAudience] = useState<'all' | 'selected'>(form.audience)
  const [selected, setSelected] = useState<string[]>(form.audienceUserIds)
  const [questions, setQuestions] = useState<DraftQuestion[]>(
    form.questions.map(toDraftQuestion),
  )
  const [tab, setTab] = useState<'questions' | 'results'>(
    form.status === 'draft' ? 'questions' : 'results',
  )
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const inputClass =
    'mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-60'

  function updateQuestion(index: number, patch: Partial<DraftQuestion>) {
    setQuestions((current) =>
      current.map((question, position) =>
        position === index ? { ...question, ...patch } : question,
      ),
    )
  }

  function changeType(index: number, type: FormQuestionType) {
    const current = questions[index]

    const needsOptions = type === 'choice' || type === 'multi-choice'
    updateQuestion(index, {
      type,
      options: needsOptions
        ? current.options.length >= 2
          ? current.options
          : ['', '']
        : current.options,
    })
  }

  function addQuestion() {
    if (questions.length >= FORM_LIMITS.questions) return

    setQuestions((current) => [
      ...current,
      {
        type: 'short-text',
        prompt: '',
        help: '',
        required: false,
        options: [],
        scaleLowLabel: '',
        scaleHighLabel: '',
      },
    ])
  }

  function removeQuestion(index: number) {
    setQuestions((current) =>
      current.filter((_, position) => position !== index),
    )
  }

  function moveQuestion(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= questions.length) return

    setQuestions((current) => {
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })
  }

  async function persist(): Promise<boolean> {
    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      const result = await saveAction({
        data: {
          id,
          draft: {
            title,
            description,
            audience,
            audienceUserIds: audience === 'selected' ? selected : [],
            questions,
          },
        },
      })

      if (result.error) {
        setError(result.error)
        return false
      }

      setNotice('Saved.')
      return true
    } catch {
      setError('Could not reach the server. Try again.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function onPublish() {
    setError(null)

    const saved = await persist()
    if (!saved) return

    const result = await publishAction({ data: { id } })
    if (result.error) {
      setError(result.error)
      return
    }

    setTab('results')
    setNotice('Published. It is in the inbox for its audience.')
    await router.invalidate()
  }

  async function onClose() {
    if (!window.confirm('Close this form? It stops accepting answers.')) return

    const result = await closeAction({ data: { id } })
    if (result.error) {
      setError(result.error)
      return
    }

    setTab('results')
    setNotice('Closed.')
    await router.invalidate()
  }

  async function onDuplicate() {
    const result = await duplicateAction({ data: { id } })
    if (result.error || !result.id) {
      setError(result.error ?? 'Could not duplicate it.')
      return
    }

    await router.navigate({
      to: '/admin/forms/$id',
      params: { id: result.id },
    })
  }

  async function onDelete() {
    if (!window.confirm('Delete this draft? It has no answers to lose.')) return

    const result = await deleteAction({ data: { id } })
    if (result.error) {
      setError(result.error)
      return
    }

    await router.navigate({ to: '/admin/forms' })
  }

  async function onDownloadCsv() {
    const result = await csvAction({ data: { id } })
    if (result.error || !result.csv || !result.filename) {
      setError(result.error ?? 'Could not build the CSV.')
      return
    }

    const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = result.filename
    link.click()
    URL.revokeObjectURL(url)
  }

  async function onCopyLink() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/ask/${id}`,
      )
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      setError('The browser refused the clipboard.')
    }
  }

  const previewQuestions: FormQuestionView[] = questions.map(
    (question, index) => ({
      id: `preview-${index}`,
      key: `q${index + 1}`,
      position: index,
      type: question.type,
      prompt: question.prompt.trim() || 'Untitled question',
      help: question.help.trim() || null,
      required: question.required,
      options: question.options
        .map((option) => option.trim())
        .filter(Boolean),
      scaleLowLabel: question.scaleLowLabel.trim() || null,
      scaleHighLabel: question.scaleHighLabel.trim() || null,
    }),
  )

  return (
    <div className="mx-auto max-w-3xl p-8">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link
            to="/admin/forms"
            className="text-xs text-muted-foreground hover:underline"
          >
            ← All forms
          </Link>
          <h1 className="mt-1 text-2xl font-bold">
            {readOnly ? form.title : 'Edit form'}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {form.status === 'draft'
              ? 'Draft — editable until you publish.'
              : form.status === 'open'
                ? 'Published — questions are frozen. Close it when you have enough answers.'
                : `Closed${form.closedAt ? ` on ${form.closedAt.toLocaleDateString()}` : ''}.`}
          </p>
        </div>
        <div className="flex flex-wrap items-baseline gap-3 text-xs">
          {form.status !== 'draft' ? (
            <button
              onClick={() => void onCopyLink()}
              className="text-primary hover:underline"
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          ) : null}
          <button
            onClick={() => void onDuplicate()}
            className="text-muted-foreground hover:underline"
          >
            Duplicate
          </button>
          {form.status === 'open' ? (
            <button
              onClick={() => void onClose()}
              className="text-muted-foreground hover:underline"
            >
              Close
            </button>
          ) : null}
          {form.status === 'draft' ? (
            <button
              onClick={() => void onDelete()}
              className="text-destructive hover:underline"
            >
              Delete
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}

      <div className="mt-6 flex gap-2 text-sm">
        <button
          onClick={() => setTab('questions')}
          className={
            tab === 'questions'
              ? 'rounded-md bg-muted px-3 py-1 font-medium'
              : 'rounded-md px-3 py-1 text-muted-foreground hover:underline'
          }
        >
          Questions
        </button>
        <button
          onClick={() => setTab('results')}
          className={
            tab === 'results'
              ? 'rounded-md bg-muted px-3 py-1 font-medium'
              : 'rounded-md px-3 py-1 text-muted-foreground hover:underline'
          }
        >
          Results{' '}
          {results ? (
            <span className="text-xs text-muted-foreground">
              ({results.counts.submitted})
            </span>
          ) : null}
        </button>
      </div>

      {tab === 'questions' ? (
        <div className="mt-6">
          <label className="block text-xs text-muted-foreground">
            Title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={readOnly}
              maxLength={FORM_LIMITS.title}
              className={inputClass}
            />
          </label>

          <label className="mt-3 block text-xs text-muted-foreground">
            Description
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={readOnly}
              rows={3}
              maxLength={FORM_LIMITS.description}
              className={inputClass}
            />
          </label>

          <fieldset className="mt-5" disabled={readOnly}>
            <legend className="text-xs text-muted-foreground">Audience</legend>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={audience === 'all'}
                onChange={() => setAudience('all')}
              />
              Everyone who has connected a mailbox
            </label>
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={audience === 'selected'}
                onChange={() => setAudience('selected')}
              />
              Only the people I pick
            </label>

            {audience === 'selected' ? (
              <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border p-2">
                {people.map((person) => (
                  <label
                    key={person.id}
                    className="flex items-center gap-2 py-0.5 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(person.id)}
                      onChange={(event) => {
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, person.id]
                            : current.filter((entry) => entry !== person.id),
                        )
                      }}
                    />
                    {person.id}
                    {person.name ? (
                      <span className="text-muted-foreground">
                        · {person.name}
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            ) : null}
          </fieldset>

          <div className="mt-6 flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              Questions{' '}
              <span className="font-normal text-muted-foreground">
                ({questions.length}/{FORM_LIMITS.questions})
              </span>
            </h2>
            <button
              onClick={() => setPreview((current) => !current)}
              className="text-xs text-primary hover:underline"
            >
              {preview ? 'Hide preview' : 'Preview'}
            </button>
          </div>

          <ol className="mt-2 space-y-3">
            {questions.map((question, index) => (
              <li
                key={index}
                className="rounded-md border border-border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {index + 1}.
                  </span>
                  <select
                    value={question.type}
                    onChange={(event) =>
                      changeType(index, event.target.value as FormQuestionType)
                    }
                    disabled={readOnly}
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                  >
                    {FORM_QUESTION_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {QUESTION_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={question.required}
                      onChange={(event) =>
                        updateQuestion(index, {
                          required: event.target.checked,
                        })
                      }
                      disabled={readOnly}
                    />
                    Required
                  </label>
                  {!readOnly ? (
                    <span className="ml-auto flex gap-1 text-xs">
                      <button
                        onClick={() => moveQuestion(index, -1)}
                        disabled={index === 0}
                        className="text-muted-foreground hover:underline disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => moveQuestion(index, 1)}
                        disabled={index === questions.length - 1}
                        className="text-muted-foreground hover:underline disabled:opacity-30"
                      >
                        ↓
                      </button>
                      <button
                        onClick={() => removeQuestion(index)}
                        className="ml-2 text-destructive hover:underline"
                      >
                        Remove
                      </button>
                    </span>
                  ) : null}
                </div>

                <input
                  value={question.prompt}
                  onChange={(event) =>
                    updateQuestion(index, { prompt: event.target.value })
                  }
                  placeholder="Question"
                  maxLength={FORM_LIMITS.prompt}
                  disabled={readOnly}
                  className={inputClass}
                />

                <input
                  value={question.help}
                  onChange={(event) =>
                    updateQuestion(index, { help: event.target.value })
                  }
                  placeholder="Help line (optional)"
                  maxLength={FORM_LIMITS.help}
                  disabled={readOnly}
                  className={inputClass}
                />

                {question.type === 'choice' ||
                question.type === 'multi-choice' ? (
                  <div className="mt-2 space-y-1">
                    {question.options.map((option, optionIndex) => (
                      <div key={optionIndex} className="flex items-center gap-2">
                        <input
                          value={option}
                          onChange={(event) =>
                            updateQuestion(index, {
                              options: question.options.map((entry, position) =>
                                position === optionIndex
                                  ? event.target.value
                                  : entry,
                              ),
                            })
                          }
                          placeholder={`Option ${optionIndex + 1}`}
                          maxLength={FORM_LIMITS.option}
                          disabled={readOnly}
                          className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm disabled:opacity-60"
                        />
                        {!readOnly && question.options.length > 2 ? (
                          <button
                            onClick={() =>
                              updateQuestion(index, {
                                options: question.options.filter(
                                  (_, position) => position !== optionIndex,
                                ),
                              })
                            }
                            className="text-xs text-destructive hover:underline"
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                    ))}
                    {!readOnly && question.options.length < FORM_LIMITS.options ? (
                      <button
                        onClick={() =>
                          updateQuestion(index, {
                            options: [...question.options, ''],
                          })
                        }
                        className="text-xs text-primary hover:underline"
                      >
                        Add option
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {question.type === 'scale' ? (
                  <div className="mt-2 flex gap-2">
                    <input
                      value={question.scaleLowLabel}
                      onChange={(event) =>
                        updateQuestion(index, {
                          scaleLowLabel: event.target.value,
                        })
                      }
                      placeholder="Low label (optional)"
                      maxLength={FORM_LIMITS.scaleLabel}
                      disabled={readOnly}
                      className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm disabled:opacity-60"
                    />
                    <input
                      value={question.scaleHighLabel}
                      onChange={(event) =>
                        updateQuestion(index, {
                          scaleHighLabel: event.target.value,
                        })
                      }
                      placeholder="High label (optional)"
                      maxLength={FORM_LIMITS.scaleLabel}
                      disabled={readOnly}
                      className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm disabled:opacity-60"
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>

          {!readOnly ? (
            <button
              onClick={addQuestion}
              disabled={questions.length >= FORM_LIMITS.questions}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Add question
            </button>
          ) : null}

          {preview ? (
            <div className="mt-6 rounded-md border border-border bg-muted/20 p-4">
              <p className="text-xs font-medium text-muted-foreground">
                Preview — the person answering sees this
              </p>
              <h2 className="mt-2 text-lg font-semibold">
                {title.trim() || 'Untitled form'}
              </h2>
              {description.trim() ? (
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                  {description}
                </p>
              ) : null}
              <FormFields
                questions={previewQuestions}
                answers={{}}
                disabled
                idPrefix="preview"
              />
            </div>
          ) : null}

          {!readOnly ? (
            <div className="mt-6 flex flex-wrap gap-2">
              <button
                onClick={() => void persist()}
                disabled={busy}
                className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save draft'}
              </button>
              <button
                onClick={() => void onPublish()}
                disabled={busy}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                Publish
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <ResultsPanel
          results={results}
          onDownloadCsv={() => void onDownloadCsv()}
        />
      )}
    </div>
  )
}

function ResultsPanel({
  results,
  onDownloadCsv,
}: {
  results: FormResultsView | null
  onDownloadCsv: () => void
}) {
  if (!results) {
    return (
      <p className="mt-6 text-sm text-muted-foreground">No results yet.</p>
    )
  }

  const { counts, tallies, status } = results
  const responseRate =
    counts.shown > 0 ? Math.round((counts.submitted / counts.shown) * 100) : 0

  return (
    <div className="mt-6">
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {(
          [
            ['Audience', counts.audience],
            ['Shown', counts.shown],
            ['Dismissed', counts.dismissed],
            ['Answers', counts.submitted],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-md border border-border p-2">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-lg font-semibold">{value}</div>
          </div>
        ))}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {counts.shown > 0
          ? `${responseRate}% of the people who saw it answered.`
          : 'Nobody has seen it yet.'}
        {status === 'open' ? ' Still accepting answers.' : null}
      </p>

      <button
        onClick={onDownloadCsv}
        className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm"
      >
        Download CSV
      </button>

      {counts.submitted === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">No answers yet.</p>
      ) : null}

      <div className="mt-6 space-y-6">
        {tallies.map((tally, index) => (
          <section
            key={tally.id}
            className="rounded-md border border-border p-3"
          >
            <h3 className="text-sm font-medium">
              <span className="mr-2 text-xs text-muted-foreground">
                {index + 1}.
              </span>
              {tally.prompt}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tally.answered}{' '}
              {tally.answered === 1 ? 'answer' : 'answers'}
            </p>

            {tally.counts ? (
              <ul className="mt-2 space-y-1">
                {tally.counts.map((entry) => {
                  const max = Math.max(
                    ...tally.counts!.map((candidate) => candidate.count),
                    1,
                  )
                  return (
                    <li key={entry.option} className="text-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="capitalize">{entry.option}</span>
                        <span className="text-xs text-muted-foreground">
                          {entry.count}
                        </span>
                      </div>
                      <div className="mt-0.5 h-1.5 rounded-full bg-muted">
                        <div
                          className="h-1.5 rounded-full bg-primary"
                          style={{ width: `${(entry.count / max) * 100}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : null}

            {tally.scaleCounts ? (
              <div className="mt-2">
                <p className="text-sm">
                  Average{' '}
                  <span className="font-semibold">
                    {tally.average ?? '—'}
                  </span>{' '}
                  / 5
                </p>
                <ul className="mt-1 space-y-1">
                  {tally.scaleCounts.map((count, valueIndex) => {
                    const max = Math.max(...tally.scaleCounts!, 1)
                    return (
                      <li
                        key={FORM_SCALE_VALUES[valueIndex]}
                        className="flex items-center gap-2 text-xs"
                      >
                        <span className="w-3 text-muted-foreground">
                          {FORM_SCALE_VALUES[valueIndex]}
                        </span>
                        <div className="h-1.5 flex-1 rounded-full bg-muted">
                          <div
                            className="h-1.5 rounded-full bg-primary"
                            style={{ width: `${(count / max) * 100}%` }}
                          />
                        </div>
                        <span className="w-6 text-right text-muted-foreground">
                          {count}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : null}

            {tally.texts ? (
              <ul className="mt-2 space-y-2">
                {tally.texts.length === 0 ? (
                  <li className="text-sm text-muted-foreground">
                    No written answers.
                  </li>
                ) : null}
                {tally.texts.map((entry, entryIndex) => (
                  <li
                    key={`${entry.userId}-${entryIndex}`}
                    className="rounded-md border border-border/60 p-2 text-sm"
                  >
                    <p className="whitespace-pre-wrap">{entry.text}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {entry.userId}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  )
}
