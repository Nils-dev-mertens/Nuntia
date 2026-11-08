/**
 * The questions, from the answering side.
 *
 * Shared by the two `/ask` pages and the inbox's questions window: a form is one
 * thing whether it is opened from a link or from inside the app, and the rules
 * about who may see it must not exist twice. Keeping the calls here also stops
 * the window from importing a route module just to reach its server function.
 */

import { createServerFn } from '@tanstack/react-start'

import { getSession } from '#/lib/auth/index.ts'
import {
  getFormForUser,
  listOpenFormsForUser,
  markFormShown,
  submitForm,
} from '#/lib/forms/repository.ts'
import type { OpenForm, UserForm } from '#/lib/forms/repository.ts'
import type { FormAnswerInput } from '#/lib/forms/validation.ts'

/** Which open forms this person may answer, with their own status on each. */
export const listOpenQuestions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<
    { signedIn: false } | { signedIn: true; forms: OpenForm[] }
  > => {
    const session = await getSession()
    if (!session) return { signedIn: false }

    return { signedIn: true, forms: await listOpenFormsForUser(session.userId) }
  },
)

/**
 * One form's questions.
 *
 * An open form records that this person saw it: that is the denominator the
 * response rate is measured against, and the write is idempotent so a re-open or
 * a poll cannot inflate it.
 */
export const loadQuestionForm = createServerFn({ method: 'GET' })
  .validator((data: { id: string }) => data)
  .handler(
    async ({
      data,
    }): Promise<{ signedIn: false } | { signedIn: true; form: UserForm }> => {
      const session = await getSession()
      if (!session) return { signedIn: false }

      const form = await getFormForUser(data.id, session.userId)
      if (form.state === 'open') {
        await markFormShown(data.id, session.userId)
      }

      return { signedIn: true, form }
    },
  )

export const submitQuestionAnswers = createServerFn({ method: 'POST' })
  .validator((data: { id: string; answers: FormAnswerInput[] }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    const result = await submitForm(data.id, session.userId, data.answers)
    return { error: result.ok ? null : result.error }
  })
