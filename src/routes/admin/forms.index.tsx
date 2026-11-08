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

import { AdminShell } from '#/components/admin-shell.tsx'
import { currentOperator } from '#/lib/admin/guard.ts'
import { createFormDraft, listFormsForAdmin } from '#/lib/forms/repository.ts'
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
    <AdminShell active="forms">
      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">All forms</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Newest first. A draft is editable; a published form is not.
            </p>
          </div>
          <button
            onClick={() => void onCreate()}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'New form'}
          </button>
        </div>

        <div className="mt-3 overflow-x-auto">
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
                  <td
                    colSpan={6}
                    className="py-4 text-sm text-muted-foreground"
                  >
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
      </section>
    </AdminShell>
  )
}
