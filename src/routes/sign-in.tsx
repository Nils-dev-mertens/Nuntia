/**
 * Sign in.
 *
 * A page rather than a modal: this is the entry point of the app, and the whole
 * screen is the one thing to do. The loader sends an already-signed-in visitor
 * straight to the inbox, so a bookmark to the inbox and a refresh both keep
 * working whether or not a session exists.
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
  authenticateUser,
  countUsers,
  createSession,
  getSession,
} from '#/lib/auth/index.ts'

/**
 * Whether the visitor already has a session, and whether any account exists.
 *
 * Behind a server function because the session module imports
 * `@tanstack/react-start/server`, which the client build refuses to pull in.
 * Without the boundary the loader's import is denied in the browser and the
 * page never hydrates.
 */
const loadSignInState = createServerFn({ method: 'GET' }).handler(
  async (): Promise<
    { signedIn: true } | { signedIn: false; emptyInstall: boolean }
  > => {
    const session = await getSession()
    if (session) return { signedIn: true }

    // Read after the session, which is what creates the environment's default
    // user if there is one: otherwise the very first visit would claim no users
    // exist while the default one is being created.
    return { signedIn: false, emptyInstall: (await countUsers()) === 0 }
  },
)

const signInAction = createServerFn({ method: 'POST' })
  .validator((data: { email: string; password: string }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const result = await authenticateUser(data.email, data.password)
    if ('error' in result) return { error: result.error }

    // The cookie is written here, on the server: the browser never sees the
    // token, only the opaque session id it comes back with.
    await createSession(result.user.id)
    return { error: null }
  })

export const Route = createFileRoute('/sign-in')({
  loader: async () => {
    const state = await loadSignInState()
    if (state.signedIn) throw redirect({ to: '/' })

    return { emptyInstall: state.emptyInstall }
  },
  component: SignIn,
})

function SignIn() {
  const { emptyInstall } = Route.useLoaderData()
  const router = useRouter()

  return (
    <AuthForm
      mode="sign-in"
      submit={async (credentials) => {
        const result = await signInAction({
          data: { email: credentials.email, password: credentials.password },
        })

        if (!result.error) {
          // Everything on the page keys off the loader's session, so the
          // navigation has to re-run it rather than only swap the URL.
          await router.invalidate()
          await router.navigate({ to: '/' })
        }

        return result
      }}
      hint={
        <>
          {emptyInstall ? 'No accounts exist yet — ' : 'No account yet? '}
          <Link to="/sign-up" className="text-primary hover:underline">
            create one
          </Link>
          .
        </>
      }
    />
  )
}
