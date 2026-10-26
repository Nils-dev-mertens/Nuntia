/**
 * `/feedback` — one question, no survey.
 *
 * Reachable from the inbox header and from a thread that was just marked done,
 * which is the moment the product has either helped or got in the way. The
 * route is deliberately a page rather than a modal: a modal on first load is
 * how people learn to dismiss the thing you most wanted them to read.
 *
 * The thread id arrives in the query string and is stored as `context`, so a
 * complaint about the composer is attached to the thread it happened on without
 * asking the person to describe it again.
 */

import { createServerFn } from '@tanstack/react-start'
import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { getSession } from '#/lib/auth/index.ts'
import { submitFeedback } from '#/lib/feedback/repository.ts'

const loadFeedbackState = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ signedIn: boolean; userId: string | null }> => {
    const session = await getSession()
    return { signedIn: Boolean(session), userId: session?.userId ?? null }
  },
)

const feedbackAction = createServerFn({ method: 'POST' })
  .validator(
    (data: {
      message: string
      rating: number | null
      email: string | null
      context: string | null
    }) => data,
  )
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    const result = await submitFeedback({
      userId: session.userId,
      message: data.message,
      rating: data.rating,
      email: data.email,
      context: data.context,
    })

    return result.ok ? { error: null } : { error: result.error }
  })

export const Route = createFileRoute('/feedback')({
  validateSearch: (search: Record<string, unknown>): { thread?: string } => {
    const thread =
      typeof search.thread === 'string' ? search.thread.slice(0, 200) : undefined

    // Returning an empty object when there is no thread is what makes `search`
    // optional for callers that only want the form.
    return thread ? { thread } : {}
  },
  loader: async () => {
    const state = await loadFeedbackState()
    if (!state.signedIn) throw redirect({ to: '/' })
    return {}
  },
  component: FeedbackPage,
})

function FeedbackPage() {
  const { thread } = Route.useSearch()
  const [message, setMessage] = useState('')
  const [rating, setRating] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    setBusy(true)
    setError(null)
    try {
      const context =
        typeof window === 'undefined'
          ? thread
            ? `thread:${thread}`
            : null
          : thread
            ? `${window.location.pathname}?thread=${encodeURIComponent(thread)}`
            : window.location.pathname

      const result = await feedbackAction({
        data: {
          message,
          rating: rating ? Number(rating) : null,
          email: email.trim() || null,
          context,
        },
      })

      if (result.error) {
        setError(result.error)
        return
      }

      setSent(true)
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground'

  if (sent) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-8">
        <h1 className="text-2xl font-bold">Thank you</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          That is read by one person, and it is the most useful thing you can
          give a beta.
        </p>
        <Link to="/" className="mt-4 text-sm text-primary hover:underline">
          Back to the inbox
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-8">
      <h1 className="text-2xl font-bold">What got in the way?</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {thread
          ? 'About the thread you just finished.'
          : 'Anything: a bug, a wrong draft, a click that should not exist.'}
      </p>

      <form onSubmit={(event) => void onSubmit(event)} className="mt-6 space-y-3">
        <label className="block text-xs text-muted-foreground">
          Your answer
          <textarea
            required
            rows={6}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            className={inputClass}
          />
        </label>

        <label className="block text-xs text-muted-foreground">
          How did it go?{' '}
          <span className="text-muted-foreground/60">(optional)</span>
          <select
            value={rating}
            onChange={(event) => setRating(event.target.value)}
            className={inputClass}
          >
            <option value="">No rating</option>
            <option value="1">1 — got in the way</option>
            <option value="2">2</option>
            <option value="3">3 — fine</option>
            <option value="4">4</option>
            <option value="5">5 — exactly right</option>
          </select>
        </label>

        <label className="block text-xs text-muted-foreground">
          Email, if you want a reply{' '}
          <span className="text-muted-foreground/60">(optional)</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            className={inputClass}
          />
        </label>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>

      <p className="mt-4 text-xs text-muted-foreground">
        <Link to="/" className="text-primary hover:underline">
          Back to the inbox
        </Link>
      </p>
    </div>
  )
}
