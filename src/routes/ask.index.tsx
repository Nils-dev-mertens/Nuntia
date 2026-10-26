/**
 * `/ask` — the questions the operator has open right now.
 *
 * A page rather than a permanent banner: the banner promotes one form, and this
 * is where the rest live. Dismissing the banner does not hide a form here, so a
 * dismissed question is still one click away if the person changes their mind.
 */

import { createServerFn } from '@tanstack/react-start'
import { Link, createFileRoute, redirect } from '@tanstack/react-router'

import { getSession } from '#/lib/auth/index.ts'
import { listOpenFormsForUser } from '#/lib/forms/repository.ts'
import type { OpenForm } from '#/lib/forms/repository.ts'

const loadOpenForms = createServerFn({ method: 'GET' }).handler(
  async (): Promise<
    { signedIn: false } | { signedIn: true; forms: OpenForm[] }
  > => {
    const session = await getSession()
    if (!session) return { signedIn: false }

    return { signedIn: true, forms: await listOpenFormsForUser(session.userId) }
  },
)

export const Route = createFileRoute('/ask/')({
  loader: async () => {
    const state = await loadOpenForms()
    if (!state.signedIn) throw redirect({ to: '/sign-in' })

    return { forms: state.forms }
  },
  component: AskIndex,
})

function AskIndex() {
  const { forms } = Route.useLoaderData()

  return (
    <div className="mx-auto max-w-2xl p-8">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold">Questions</h1>
        <Link to="/" className="text-xs text-muted-foreground hover:underline">
          Back to the inbox
        </Link>
      </header>

      <p className="mt-2 text-sm text-muted-foreground">
        Short questions from the person building Nuntia. Answers are attached to
        your account and visible only to them.
      </p>

      {forms.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          Nothing open right now. The{' '}
          <Link to="/feedback" className="text-primary hover:underline">
            feedback box
          </Link>{' '}
          is always there.
        </p>
      ) : (
        <ul className="mt-6 space-y-2">
          {forms.map((form) => (
            <li key={form.id}>
              <Link
                to="/ask/$id"
                params={{ id: form.id }}
                className="block rounded-md border border-border p-3 transition-colors hover:border-foreground/25"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{form.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {form.questionCount}{' '}
                    {form.questionCount === 1 ? 'question' : 'questions'}
                    {form.submitted
                      ? ' · answered, still editable'
                      : form.dismissed
                        ? ' · dismissed'
                        : ''}
                  </span>
                </div>
                {form.description ? (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {form.description}
                  </p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
