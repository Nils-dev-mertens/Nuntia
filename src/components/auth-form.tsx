/**
 * The sign-in and sign-up form.
 *
 * One component for both because the two differ only in the fields they show and
 * the sentence under them — the states, the styling and the error handling are
 * the same, and a second copy is how they drift apart.
 *
 * It never touches the session: the caller passes a server function that returns
 * a message to display or null, and handles navigation itself. That keeps the
 * cookie writing on the server where it belongs.
 */

import { useState } from 'react'
import type { FormEvent } from 'react'

export type AuthMode = 'sign-in' | 'sign-up'

export type AuthCredentials = {
  email: string
  password: string
  /** Only sent when creating an account. */
  name: string | null
}

export function AuthForm({
  mode,
  submit,
  hint,
}: {
  mode: AuthMode
  /** Runs on the server, creates the session, and reports a message to show. */
  submit: (credentials: AuthCredentials) => Promise<{ error: string | null }>
  hint?: React.ReactNode
}) {
  const signingUp = mode === 'sign-up'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    // Checked here as well as on the server: a mistyped confirmation is a
    // keystroke-level mistake, and a round trip to be told so is annoying.
    if (signingUp && password !== confirm) {
      setError('Those passwords do not match.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const result = await submit({
        email,
        password,
        name: name.trim() || null,
      })
      setError(result.error)
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground'

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8">
      <h1 className="text-2xl font-bold">
        {signingUp ? 'Create your account' : 'Sign in to Nuntia'}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {signingUp
          ? 'Your mailboxes and settings are yours alone — nobody else on this install sees them.'
          : 'Your mailboxes, keys and settings stay on this machine.'}
      </p>

      <form
        onSubmit={(event) => void onSubmit(event)}
        className="mt-6 space-y-3"
      >
        {signingUp ? (
          <label className="block text-xs text-muted-foreground">
            Name <span className="text-muted-foreground/60">(optional)</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              className={inputClass}
            />
          </label>
        ) : null}

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
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={signingUp ? 'new-password' : 'current-password'}
            className={inputClass}
          />
        </label>

        {signingUp ? (
          <label className="block text-xs text-muted-foreground">
            Confirm password
            <input
              type="password"
              required
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
              className={inputClass}
            />
          </label>
        ) : null}

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
          {busy
            ? signingUp
              ? 'Creating…'
              : 'Signing in…'
            : signingUp
              ? 'Create account'
              : 'Sign in'}
        </button>
      </form>

      {hint ? (
        <p className="mt-4 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
