/**
 * `/request-access` — the only page a stranger can reach during the beta.
 *
 * Four fields, no marketing, and one answer however it went. The free-text
 * question is the point: it is written before anyone has seen the product, so
 * it cannot be reverse-engineered from behaviour, and it is the first thing that
 * tells you whether the next twenty people are the right twenty.
 *
 * The submission is a row, not an email to the operator. An inbox is where
 * requests go to be forgotten; a queue is where they get decided.
 */

import { createServerFn } from '@tanstack/react-start'
import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { accessMode, getSession } from '#/lib/auth/index.ts'
import { submitRequest } from '#/lib/invites/requests.ts'

/**
 * The one sentence every outcome gets: new address, already pending, already
 * has an account, declined last week. A local constant rather than an import
 * from `requests.ts`, because that module imports server-only helpers and a
 * value used in JSX would pull it into the client bundle.
 */
const REQUEST_RECEIVED =
  "Request received. If it's a fit, you'll get a link by email."

const loadRequestEntry = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ mode: 'invite' | 'login'; signedIn: boolean }> => {
    const session = await getSession()
    return { mode: accessMode(), signedIn: Boolean(session) }
  },
)

const requestAccessAction = createServerFn({ method: 'POST' })
  .validator(
    (data: {
      email: string
      name: string | null
      note: string
      source: string | null
      website: string | null
    }) => data,
  )
  .handler(async ({ data }) => submitRequest(data))

export const Route = createFileRoute('/request-access')({
  loader: async () => {
    const state = await loadRequestEntry()

    // In login mode this page has no meaning: there is nothing to request.
    if (state.mode === 'login') throw redirect({ to: '/sign-up' })
    if (state.signedIn) throw redirect({ to: '/' })

    return {}
  },
  component: RequestAccess,
})

function RequestAccess() {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [source, setSource] = useState('')
  const [website, setWebsite] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    setBusy(true)
    setError(null)
    try {
      const result = await requestAccessAction({
        data: {
          email,
          name: name.trim() || null,
          note,
          source: source.trim() || null,
          website: website.trim() || null,
        },
      })

      if (!result.ok) {
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
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8">
        <h1 className="text-2xl font-bold">Thanks</h1>
        <p className="mt-2 text-sm text-muted-foreground">{REQUEST_RECEIVED}</p>
        <p className="mt-4 text-xs text-muted-foreground">
          Already have a code?{' '}
          <Link to="/join" className="text-primary hover:underline">
            Enter it here
          </Link>
          .
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8">
      <h1 className="text-2xl font-bold">Ask for access</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Nuntia is a small beta. Tell me what you are trying to fix and I will
        send a link if it fits.
      </p>

      <form onSubmit={(event) => void onSubmit(event)} className="mt-6 space-y-3">
        <label className="block text-xs text-muted-foreground">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            className={inputClass}
          />
        </label>

        <label className="block text-xs text-muted-foreground">
          Name <span className="text-muted-foreground/60">(optional)</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            className={inputClass}
          />
        </label>

        <label className="block text-xs text-muted-foreground">
          What are you trying to fix?
          <textarea
            required
            rows={4}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className={inputClass}
          />
        </label>

        <label className="block text-xs text-muted-foreground">
          How did you hear about it?{' '}
          <span className="text-muted-foreground/60">(optional)</span>
          <input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className={inputClass}
          />
        </label>

        {/* Not hidden with `display:none` alone: a script that fills every field
            still fills this one, and the submission is dropped with the normal
            answer. */}
        <div className="absolute left-[-9999px] top-auto h-0 w-0 overflow-hidden">
          <label>
            Website
            <input
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
            />
          </label>
        </div>

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
          {busy ? 'Sending…' : 'Request access'}
        </button>
      </form>

      <p className="mt-4 text-xs text-muted-foreground">
        Already have a code?{' '}
        <Link to="/join" className="text-primary hover:underline">
          Enter it here
        </Link>
        .
      </p>
    </div>
  )
}
