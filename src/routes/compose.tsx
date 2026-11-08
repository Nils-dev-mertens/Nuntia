/**
 * Write a new message.
 *
 * A page rather than only the inbox's window: this is the deep link, and the
 * fallback for a place that has no shell around it. The window itself lives in
 * `components/compose-overlay.tsx` and uses the same calls.
 */

import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'

import { Compose } from '#/components/compose.tsx'
import {
  loadComposeState,
  loadStylePreview,
  sendMessageAction,
} from '#/lib/mailbox/compose-actions.ts'

export const Route = createFileRoute('/compose')({
  loader: async () => {
    const state = await loadComposeState()
    if (!state.signedIn) throw redirect({ to: '/sign-in' })
    return state
  },
  component: ComposePage,
})

function ComposePage() {
  const { accounts, suggestions } = Route.useLoaderData()
  const router = useRouter()

  return (
    <Compose
      accounts={accounts}
      suggestions={suggestions}
      loadStyle={(input) => loadStylePreview({ data: input })}
      submit={async (input) => {
        const result = await sendMessageAction({ data: input })

        if (!result.error) {
          // The inbox and the thread both come from loader data: invalidate
          // before moving on, or the new conversation is not in the router's
          // cache yet and the detail page renders not-found.
          await router.invalidate()

          if (result.threadId) {
            await router.navigate({
              to: '/conversations/$providerThreadId',
              params: { providerThreadId: result.threadId },
            })
          } else {
            // Graph's send reports no thread id; the message appears on the
            // next sync, so the list is the honest destination.
            await router.navigate({ to: '/' })
          }
        }

        return result
      }}
    />
  )
}
