/**
 * What beta users said got in the way.
 *
 * One row per submission, no threading, no attachments. The route travels with
 * it (`context`) so a complaint about the composer arrives attached to where it
 * happened, and the thread id travels with that when there is one.
 *
 * The email is optional and user-supplied: filling it in is permission to reply
 * by mail. Requiring it would silence exactly the people most likely to have a
 * problem.
 */

import { randomUUID } from 'node:crypto'

import { desc, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { feedback } from '#/db/schema.ts'
import type { Feedback, FeedbackStatus } from '#/db/schema.ts'

const MAX_MESSAGE_LENGTH = 4_000
const MAX_CONTEXT_LENGTH = 500
const MAX_EMAIL_LENGTH = 254

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type SubmitFeedbackInput = {
  userId: string
  message: string
  rating?: number | null
  email?: string | null
  context?: string | null
}

export type SubmitFeedbackResult = { ok: true } | { ok: false; error: string }

export async function submitFeedback(
  input: SubmitFeedbackInput,
): Promise<SubmitFeedbackResult> {
  const message = input.message.trim()
  if (!message) return { ok: false, error: 'Write a sentence first.' }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: 'That is too long to send — trim it a little.' }
  }

  const rating = input.rating ?? null
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return { ok: false, error: 'Rate it from 1 to 5, or leave it blank.' }
  }

  const email = input.email?.trim().toLowerCase() || null
  if (email && (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email))) {
    return { ok: false, error: 'That email does not look right.' }
  }

  const context = input.context?.trim().slice(0, MAX_CONTEXT_LENGTH) || null

  try {
    await db.insert(feedback).values({
      id: randomUUID(),
      userId: input.userId.toLowerCase(),
      email,
      rating,
      message,
      context,
    })
  } catch (error) {
    console.error('[feedback] could not store it:', error)
    return { ok: false, error: 'Could not save that. Try again in a moment.' }
  }

  return { ok: true }
}

/** Newest first, for `/admin`. */
export async function listFeedback(): Promise<Feedback[]> {
  return db.query.feedback.findMany({ orderBy: desc(feedback.createdAt) })
}

/** Move one row through the operator's status loop. */
export async function setFeedbackStatus(
  id: string,
  status: FeedbackStatus,
  note: string | null,
): Promise<boolean> {
  const result = await db
    .update(feedback)
    .set({ status, resolutionNote: note?.trim() || null })
    .where(eq(feedback.id, id))

  return result.rowsAffected > 0
}
