/**
 * `/join` — for a code that is read aloud rather than clicked.
 *
 * It deliberately does not redeem anything. It normalises what was typed and
 * navigates to `/join/<code>`, so there is exactly one redemption path and the
 * successful attempt leaves a URL that can be bookmarked and reused.
 */

import { createServerFn } from '@tanstack/react-start'
import {
  Link,
  createFileRoute,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'

import {
  formatCode,
  normaliseCode,
} from '#/lib/invites/codes.ts'
import { accessMode, getSession } from '#/lib/auth/index.ts'

const loadJoinEntry = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ mode: 'invite' | 'login'; signedIn: boolean }> => {
    const session = await getSession()
    return { mode: accessMode(), signedIn: Boolean(session) }
  },
)

export const Route = createFileRoute('/join/')({
  loader: async () => {
    const state = await loadJoinEntry()

    if (state.mode === 'login') throw redirect({ to: '/sign-in' })
    if (state.signedIn) throw redirect({ to: '/' })

    return {}
  },
  component: JoinByCode,
})

function JoinByCode() {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const canonical = normaliseCode(code)
    if (!canonical) {
      setError('That does not look like an invite code.')
      return
    }

    await router.navigate({
      to: '/join/$code',
      params: { code: formatCode(canonical) },
    })
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8">
      <h1 className="text-2xl font-bold">Enter your invite code</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Twelve characters, usually in three groups of four. Dashes and capitals
        do not matter.
      </p>

      <form onSubmit={(event) => void onSubmit(event)} className="mt-6 space-y-3">
        <label className="block text-xs text-muted-foreground">
          Code
          <input
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="one-time-code"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </label>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Continue
        </button>
      </form>

      <p className="mt-4 text-xs text-muted-foreground">
        No code yet?{' '}
        <Link to="/request-access" className="text-primary hover:underline">
          Ask for access
        </Link>
        .
      </p>
    </div>
  )
}
