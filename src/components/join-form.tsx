/**
 * The form an invite lands on.
 *
 * Presentational on purpose: it never touches the session or the database. The
 * route passes a server function that redeems the code and starts the session,
 * which keeps every cookie write on the server and lets the same markup serve a
 * link that already knows its code and a page where it is typed by hand.
 *
 * The address is locked when the invite is bound to one. It is shown rather
 * than hidden because the person reading the email already knows it, and a
 * greyed-out field explains why a different address will not work.
 */

import { useState } from 'react'
import type { FormEvent } from 'react'

export type JoinCredentials = {
  code: string
  email: string
  name: string | null
  password: string
}

/** Matches the server's rule in `lib/auth/users.ts`; the server decides. */
const MIN_PASSWORD_LENGTH = 10

export function JoinForm({
  code,
  lockedEmail,
  codeEditable = false,
  submit,
}: {
  code: string
  /** Set when the invite is bound to an address; the field becomes read-only. */
  lockedEmail?: string | null
  codeEditable?: boolean
  submit: (credentials: JoinCredentials) => Promise<{ error: string | null }>
}) {
  const [enteredCode, setEnteredCode] = useState(code)
  const [email, setEmail] = useState(lockedEmail ?? '')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    // A mistyped confirmation is a keystroke-level mistake; a round trip to be
    // told so is annoying. The server holds the rule that matters.
    if (password !== confirm) {
      setError('Those passwords do not match.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const result = await submit({
        code: enteredCode,
        email,
        name: name.trim() || null,
        password,
      })
      setError(result.error)
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-60'

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8">
      <h1 className="text-2xl font-bold">You&apos;re in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Confirm the address this invite is for and choose a password. The invite
        is what gets you in today; the password is what brings you back without
        digging up this email again.
      </p>

      <form
        onSubmit={(event) => void onSubmit(event)}
        className="mt-6 space-y-3"
      >
        {codeEditable ? (
          <label className="block text-xs text-muted-foreground">
            Invite code
            <input
              required
              value={enteredCode}
              onChange={(event) => setEnteredCode(event.target.value)}
              autoComplete="one-time-code"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX"
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
            readOnly={Boolean(lockedEmail)}
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
          Password
          <input
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            className={inputClass}
          />
          <span className="mt-1 block text-muted-foreground/60">
            At least {MIN_PASSWORD_LENGTH} characters.
          </span>
        </label>

        <label className="block text-xs text-muted-foreground">
          Confirm password
          <input
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
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
          {busy ? 'Opening…' : 'Open Nuntia'}
        </button>
      </form>

      <p className="mt-4 text-xs text-muted-foreground">
        Nuntia will ask for a mailbox next — that is what proves the address
        works, and where the mail comes from. You can sign in at{' '}
        <code>/sign-in</code> with this address and password from any browser.
      </p>
    </div>
  )
}
