/**
 * Create an account.
 *
 * Registration is open: anyone who can reach the deployment can sign up, and
 * nobody sees anybody else's mail. The first account is the exception in one
 * respect only — it adopts the mailboxes that were connected before accounts
 * existed, so an install that was already in use is not stranded.
 *
 * That adoption is the reason the loader reports whether the install is empty.
 * After the first account, connecting a mailbox is an explicit action from the
 * inbox, and no later sign-up claims anything.
 */

import { createServerFn } from '@tanstack/react-start'
import {
  Link,
  createFileRoute,
  redirect,
  useRouter,
} from '@tanstack/react-router'

import { AuthForm } from '#/components/auth-form.tsx'
import {
  countUsers,
  createSession,
  getSession,
  registerUser,
} from '#/lib/auth/index.ts'

/**
 * Whether the visitor is already signed in, and whether this install is empty.
 *
 * A server function rather than a loader that imports the session directly: the
 * session module reaches `@tanstack/react-start/server`, which the client build
 * refuses to import. Keeping the call behind an RPC boundary means the route's
 * loader works the same on the server and in the browser.
 */
const loadSignUpState = createServerFn({ method: 'GET' }).handler(
  async (): Promise<
    { signedIn: true } | { signedIn: false; firstAccount: boolean }
  > => {
    const session = await getSession()
    if (session) return { signedIn: true }

    return { signedIn: false, firstAccount: (await countUsers()) === 0 }
  },
)

const signUpAction = createServerFn({ method: 'POST' })
  .validator(
    (data: { email: string; password: string; name: string | null }) => data,
  )
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const result = await registerUser({
      email: data.email,
      password: data.password,
      name: data.name,
    })

    if ('error' in result) return { error: result.error }

    await createSession(result.user.id)
    return { error: null }
  })

export const Route = createFileRoute('/sign-up')({
  loader: async () => {
    const state = await loadSignUpState()
    if (state.signedIn) throw redirect({ to: '/' })

    return { firstAccount: state.firstAccount }
  },
  component: SignUp,
})

function SignUp() {
  const { firstAccount } = Route.useLoaderData()
  const router = useRouter()

  return (
    <AuthForm
      mode="sign-up"
      submit={async (credentials) => {
        const result = await signUpAction({ data: credentials })

        if (!result.error) {
          await router.invalidate()
          await router.navigate({ to: '/' })
        }

        return result
      }}
      hint={
        firstAccount ? (
          <>
            This is the first account, so any mailbox already connected on this
            machine becomes yours.{' '}
            <Link to="/sign-in" className="text-primary hover:underline">
              Sign in instead
            </Link>
            .
          </>
        ) : (
          <>
            Already have an account?{' '}
            <Link to="/sign-in" className="text-primary hover:underline">
              Sign in
            </Link>
            .
          </>
        )
      }
    />
  )
}
