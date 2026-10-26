/**
 * `/ask/<id>` — answer one form.
 *
 * The loader decides whether this person may see it at all: draft and closed
 * forms are indistinguishable from missing ones, and someone outside the
 * audience gets no hint that the form exists. Opening a form records that it was
 * shown, which is the denominator the response rate is measured against.
 */

import { createServerFn } from '@tanstack/react-start'
import { Link, createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'

import { getSession } from '#/lib/auth/index.ts'
import {
  getFormForUser,
  markFormShown,
  submitForm,
} from '#/lib/forms/repository.ts'
import type { UserForm } from '#/lib/forms/repository.ts'
import type { FormAnswerInput } from '#/lib/forms/validation.ts'
import { FormFields } from '#/components/form-fields.tsx'
import type { FormAnswers } from '#/components/form-fields.tsx'

const loadForm = createServerFn({ method: 'GET' })
  .validator((data: { id: string }) => data)
  .handler(
    async ({
      data,
    }): Promise<{ signedIn: false } | { signedIn: true; form: UserForm }> => {
      const session = await getSession()
      if (!session) return { signedIn: false }

      const form = await getFormForUser(data.id, session.userId)
      if (form.state === 'open') {
        await markFormShown(data.id, session.userId)
      }

      return { signedIn: true, form }
    },
  )

const submitAnswers = createServerFn({ method: 'POST' })
  .validator((data: { id: string; answers: FormAnswerInput[] }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    const result = await submitForm(data.id, session.userId, data.answers)
    return { error: result.ok ? null : result.error }
  })

export const Route = createFileRoute('/ask/$id')({
  loader: async ({ params }) => {
    const state = await loadForm({ data: { id: params.id } })
    if (!state.signedIn) throw redirect({ to: '/sign-in' })

    return { form: state.form }
  },
  component: AskFormPage,
})

function AskFormPage() {
  const { form } = Route.useLoaderData()
  const { id } = Route.useParams()
  const router = useRouter()

  const [answers, setAnswers] = useState<FormAnswers>(() =>
    form.state === 'open'
      ? Object.fromEntries(
          form.answers.map((answer) => [
            answer.questionId,
            {
              text: answer.text ?? undefined,
              number: answer.number,
              choices: answer.choices ?? undefined,
            },
          ]),
        )
      : {},
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || form.state !== 'open') return

    setBusy(true)
    setError(null)

    try {
      const payload: FormAnswerInput[] = form.questions.map((question) => {
        const answer = answers[question.id] ?? {}
        return {
          questionId: question.id,
          text: answer.text ?? null,
          number: answer.number ?? null,
          choices: answer.choices ?? null,
        }
      })

      const result = await submitAnswers({ data: { id, answers: payload } })

      if (result.error) {
        setError(result.error)
        return
      }

      setDone(true)
      // The inbox banner counts what is still unanswered, so it has to re-read.
      await router.invalidate()
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done || form.state === 'submitted') {
    const title = form.state === 'submitted' ? form.title : 'Thanks'

    return (
      <Shell title={title}>
        <p className="mt-2 text-sm text-muted-foreground">
          {done
            ? 'That is recorded, and it is read by the person who runs this beta.'
            : 'You already answered this one. Thank you.'}
        </p>
        <p className="mt-4 text-xs text-muted-foreground">
          You can change an answer until the form closes by opening it again from
          the Questions link.
        </p>
        <Link to="/" className="mt-6 inline-block text-sm text-primary hover:underline">
          Back to the inbox
        </Link>
      </Shell>
    )
  }

  if (form.state !== 'open') {
    return (
      <Shell title="Questions">
        <p className="mt-2 text-sm text-muted-foreground">
          {form.state === 'closed'
            ? 'This form has closed. Thanks for taking a look.'
            : 'This form is not available.'}
        </p>
        <div className="mt-6 flex gap-4 text-sm">
          <Link to="/" className="text-primary hover:underline">
            Back to the inbox
          </Link>
          <Link to="/ask" className="text-primary hover:underline">
            See open questions
          </Link>
        </div>
      </Shell>
    )
  }

  return (
    <Shell title={form.title}>
      {form.description ? (
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
          {form.description}
        </p>
      ) : null}

      {form.submitted ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          You already answered this one. Sending again replaces those answers,
          and stays possible until the form closes.
        </p>
      ) : null}

      <form onSubmit={(event) => void onSubmit(event)} className="mt-2">
        <FormFields
          questions={form.questions}
          answers={answers}
          onChange={(questionId, next) =>
            setAnswers((current) => ({ ...current, [questionId]: next }))
          }
          idPrefix="answer"
        />

        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy
            ? 'Sending…'
            : form.submitted
              ? 'Update answers'
              : 'Send answers'}
        </button>
      </form>

      <p className="mt-4 text-xs text-muted-foreground">
        Answers are attached to your account and visible only to the person who
        runs this beta.
      </p>

      <p className="mt-4 text-xs text-muted-foreground">
        <Link to="/" className="text-primary hover:underline">
          Back to the inbox
        </Link>
      </p>
    </Shell>
  )
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md p-8">
      <h1 className="text-2xl font-bold">{title}</h1>
      {children}
    </div>
  )
}
