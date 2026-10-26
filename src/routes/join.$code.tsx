/**
 * `/join/<code>` — the link an approval email carries.
 *
 * The loader validates the invite *before* rendering the form, so a dead link
 * shows one sentence instead of a form that fails on submit. The validity check
 * and the redemption deliberately share the same wording: whether a code is
 * unknown, expired, revoked or exhausted is not something a stranger with a
 * guessed link needs to learn.
 *
 * The mode is returned by the server function rather than read here, because
 * `process.env` is not the same thing in the browser and the loader runs in
 * both places.
 */

import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'

import { JoinForm } from '#/components/join-form.tsx'
import {
  createSession,
  getSession,
  invitesOnly,
} from '#/lib/auth/index.ts'
import { findInviteByCode } from '#/lib/invites/repository.ts'
import { matchesBootstrapCode, redeemInvite } from '#/lib/invites/redeem.ts'

type JoinState =
  | { mode: 'login' }
  | { mode: 'invite'; signedIn: boolean; valid: boolean; email: string | null }

/**
 * What the page needs to know, decided on the server.
 *
 * `valid` folds every refusal into one answer: unknown code, revoked, expired.
 * A bound invite still counts as valid when its uses are spent, because the
 * same address may sign back in.
 */
const inspectInvite = createServerFn({ method: 'GET' })
  .validator((code: string) => code)
  .handler(async ({ data: code }): Promise<JoinState> => {
    if (!invitesOnly()) return { mode: 'login' }

    const session = await getSession()
    if (session) return { mode: 'invite', signedIn: true, valid: false, email: null }

    const invite = await findInviteByCode(code)
    const expired = invite?.expiresAt
      ? invite.expiresAt.getTime() <= Date.now()
      : false

    // The environment bootstrap code is the way in on an empty install —
    // without it the loader would redirect the one code that can create the
    // first admin back to `/join`, which is a loop with no exit.
    const valid =
      Boolean(invite && !invite.revokedAt && !expired) ||
      (await matchesBootstrapCode(code))

    return {
      mode: 'invite',
      signedIn: false,
      valid,
      email: valid ? (invite?.email ?? null) : null,
    }
  })

const joinAction = createServerFn({ method: 'POST' })
  .validator(
    (data: { code: string; email: string; name: string | null }) => data,
  )
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    if (!invitesOnly()) return { error: 'This install uses sign-in, not invites.' }

    let userAgent: string | null = null
    try {
      userAgent = getRequestHeader('user-agent') ?? null
    } catch {
      userAgent = null
    }

    const result = await redeemInvite({
      code: data.code,
      email: data.email,
      name: data.name,
      userAgent,
    })

    if (!result.ok) return { error: result.error }

    // The cookie is written here, on the server. Redemption itself returns a
    // user id so it can be tested without a request context.
    await createSession(result.userId)
    return { error: null }
  })

export const Route = createFileRoute('/join/$code')({
  loader: async ({ params }) => {
    const state = await inspectInvite({ data: params.code })

    if (state.mode === 'login') throw redirect({ to: '/sign-in' })
    if (state.signedIn) throw redirect({ to: '/' })
    if (!state.valid) throw redirect({ to: '/join' })

    return { email: state.email }
  },
  component: JoinWithCode,
})

function JoinWithCode() {
  const { code } = Route.useParams()
  const { email } = Route.useLoaderData()
  const router = useRouter()

  return (
    <JoinForm
      code={code}
      lockedEmail={email}
      submit={async (credentials) => {
        const result = await joinAction({
          data: {
            code: credentials.code,
            email: credentials.email,
            name: credentials.name,
          },
        })

        if (!result.error) {
          await router.invalidate()
          await router.navigate({ to: '/' })
        }

        return result
      }}
    />
  )
}
