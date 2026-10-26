/**
 * `/admin/sign-in` — the operator's way back in.
 *
 * This route exists because closing password sign-in for testers must not close
 * it for the only person who can issue another invite. A 30-day cookie that
 * expires while `/admin` is the only place to mint a link is a lockout with no
 * way back.
 *
 * A non-operator gets exactly the same sentence as a wrong password, and no
 * session is created for them, so the form cannot be used to discover who
 * operates the install.
 */

import { createServerFn } from '@tanstack/react-start'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { currentOperator, isOperatorUser } from '#/lib/admin/guard.ts'
import {
  authenticateUser,
  createSession,
  destroySession,
} from '#/lib/auth/index.ts'

const loadOperatorState = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ signedIn: boolean }> => {
    const operator = await currentOperator()
    return { signedIn: Boolean(operator) }
  },
)

const operatorSignInAction = createServerFn({ method: 'POST' })
  .validator((data: { email: string; password: string }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const result = await authenticateUser(data.email, data.password)

    const refusal = 'Email or password is incorrect.'
    if ('error' in result) return { error: refusal }

    if (!(await isOperatorUser(result.user.id))) {
      // A real account, but not an operator. Make sure no session lingers from
      // the check itself — `authenticateUser` never starts one, and this keeps
      // that invariant explicit for the next reader.
      await destroySession().catch(() => {})
      return { error: refusal }
    }

    await createSession(result.user.id)
    return { error: null }
  })

export const Route = createFileRoute('/admin/sign-in')({
  loader: async () => {
    const state = await loadOperatorState()
    if (state.signedIn) throw redirect({ to: '/admin' })
    return {}
  },
  component: OperatorSignIn,
})

function OperatorSignIn() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    setBusy(true)
    setError(null)
    try {
      const result = await operatorSignInAction({
        data: { email, password },
      })

      if (result.error) {
        setError(result.error)
        return
      }

      await router.invalidate()
      await router.navigate({ to: '/admin' })
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
      <h1 className="text-2xl font-bold">Operator sign-in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The beta has no sign-in for testers. This one is for whoever runs the
        install.
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
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
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
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
