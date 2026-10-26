/**
 * `/admin/forms` — the questions the operator has written.
 *
 * A draft is a form in progress; once published it is frozen, because answers
 * only compare across time if the prompts did not change. The list is ordered
 * newest first, like every other operator queue.
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
  createFormDraft,
  listFormsForAdmin,
} from '#/lib/forms/repository.ts'
import type { AdminFormSummary } from '#/lib/forms/repository.ts'

const loadForms = createServerFn({ method: 'GET' }).handler(
  async (): Promise<
    { allowed: false } | { allowed: true; forms: AdminFormSummary[] }
  > => {
    const operator = await currentOperator()
    if (!operator) return { allowed: false }

    return { allowed: true, forms: await listFormsForAdmin() }
  },
)

const createAction = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ error: string | null; id: string | null }> => {
    const operator = await currentOperator()
    if (!operator) return { error: 'Not found.', id: null }

    return { error: null, id: await createFormDraft(operator.userId) }
  },
)

export const Route = createFileRoute('/admin/forms/')({
  loader: async () => {
    const state = await loadForms()
    if (!state.allowed) throw notFound()

    return { forms: state.forms }
  },
  component: FormsPage,
})

function FormsPage() {
  const { forms } = Route.useLoaderData()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onCreate() {
    if (busy) return
    setBusy(true)
    setError(null)

    try {
      const result = await createAction()
      if (result.error || !result.id) {
        setError(result.error ?? 'Could not create a form.')
        return
      }

      await router.navigate({
        to: '/admin/forms/$id',
        params: { id: result.id },
      })
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Forms</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Ask the beta a question. Published forms are frozen so the answers
            stay comparable.
          </p>
        </div>
        <div className="flex items-baseline gap-4 text-xs">
          <Link to="/admin" className="text-muted-foreground hover:underline">
            Back to admin
          </Link>
          <Link to="/" className="text-muted-foreground hover:underline">
            Back to the app
          </Link>
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

      <button
        onClick={() => void onCreate()}
        disabled={busy}
        className="mt-6 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {busy ? 'Creating…' : 'New form'}
      </button>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-3">Form</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1 pr-3">Questions</th>
              <th className="py-1 pr-3">Audience</th>
              <th className="py-1 pr-3">Answers</th>
              <th className="py-1 pr-3">Published</th>
            </tr>
          </thead>
          <tbody>
            {forms.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-4 text-sm text-muted-foreground">
                  Nothing yet. Create the first form.
                </td>
              </tr>
            ) : null}

            {forms.map((form) => (
              <tr key={form.id} className="border-t border-border">
                <td className="py-1 pr-3">
                  <Link
                    to="/admin/forms/$id"
                    params={{ id: form.id }}
                    className="text-primary hover:underline"
                  >
                    {form.title}
                  </Link>
                </td>
                <td className="py-1 pr-3">{form.status}</td>
                <td className="py-1 pr-3">{form.questionCount}</td>
                <td className="py-1 pr-3">
                  {form.audience === 'all'
                    ? `${form.counts.audience} people`
                    : `${form.counts.audience} selected`}
                </td>
                <td className="py-1 pr-3">
                  {form.counts.submitted}/{form.counts.audience}
                  <span className="ml-1 text-xs text-muted-foreground">
                    · {form.counts.shown} shown
                  </span>
                </td>
                <td className="py-1 pr-3">
                  {form.publishedAt
                    ? form.publishedAt.toLocaleDateString()
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
