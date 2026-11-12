/**
 * Did the reply the user just sent actually move the thread toward their goal?
 *
 * A goal is the only thing in the app that says what a good outcome looks like,
 * which also makes it the only thing that can judge a reply *after* it has gone.
 * This module is pure — prompt in, parsed verdict out — so the sentence the view
 * shows and the call the server makes cannot drift apart, and so the rule can be
 * tested without a key, a network or a database.
 *
 * It never sends and never writes. The verdict is advice the user can take or
 * ignore; the suggestion is a body for the composer, not a message.
 */

/** One message from the other side, as the check needs to read it. */
export type GoalReviewRequest = {
  /** The user's own sentence: what they want out of this conversation. */
  goal: string
  /** The user's topic, when they set one. */
  topic: string | null
  /** The newest message from the other side, which the reply answered. */
  incoming: string | null
  /** What the user actually sent. */
  sentReply: string
}

/**
 * What the model decided.
 *
 * `suggestion` is only meaningful when `meetsGoal` is false — a reply that
 * already reaches the goal has nothing to replace.
 */
export type GoalVerdict = {
  meetsGoal: boolean
  /** One sentence, in the user's terms. Null when the goal was met. */
  reason: string | null
  /** A replacement body, when the reply missed and the model wrote one. */
  suggestion: string | null
}

/** The seam the server calls; null means no model is configured. */
export interface GoalReviewer {
  readonly name: string
  review: (request: GoalReviewRequest) => Promise<GoalVerdict | null>
}

/**
 * A thread with no goal, and the reply that may reveal one.
 *
 * Only the user's own sent reply is asked about: it is the one piece of the
 * thread that says what they actually wanted, as opposed to what the other side
 * asked for.
 */
export type GoalInferenceRequest = {
  topic: string | null
  /** The newest message from the other side, which the reply answered. */
  incoming: string | null
  /** What the user actually sent. */
  sentReply: string
}

/** The seam for inferring a goal; null means no model is configured. */
export interface GoalInferrer {
  readonly name: string
  infer: (request: GoalInferenceRequest) => Promise<string | null>
}

/** A goal stays one sentence, like the one the user can type themselves. */
export const MAX_INFERRED_GOAL_LENGTH = 500

/** How much of either side the prompt carries: enough to judge, not a mailbox. */
const MAX_REVIEW_CHARS = 2_000

/**
 * The prompt, shared by every provider.
 *
 * Written as a question about one specific outcome rather than a request for
 * general feedback: a model asked "is this a good reply" answers about tone, and
 * tone is not what the user's goal is about.
 */
export function buildGoalReviewPrompt(request: GoalReviewRequest): string {
  const lines: string[] = [
    'I just sent a reply in an email thread. Judge it against my goal.',
    `My goal: ${request.goal}`,
  ]

  if (request.topic) lines.push(`Thread topic: ${request.topic}`)

  if (request.incoming) {
    lines.push(
      '',
      'The message I was answering:',
      request.incoming.slice(0, MAX_REVIEW_CHARS),
    )
  }

  lines.push(
    '',
    'The reply I sent:',
    request.sentReply.slice(0, MAX_REVIEW_CHARS),
    '',
    'Answer with JSON only — no prose, no code fence:',
    '{"meetsGoal": true or false, "reason": "one sentence, or null", "suggestion": "a complete reply body, or null"}',
    'Set meetsGoal to true only if the reply clearly moves the thread toward the goal I wrote.',
    'If it does not, reason names what is missing, and suggestion is a reply body I could send next.',
    'Do not judge politeness or style, and do not invent facts, dates, prices or commitments I did not state.',
  )

  return lines.join('\n')
}

/**
 * The prompt for a thread that has no goal.
 *
 * Deliberately not a summariser: the answer has to be an outcome the user can
 * edit and that a later reply can be judged against. The incoming message is
 * included for context, but the instruction points at the sent reply, because
 * the other side's request is not automatically what the user wanted.
 */
export function buildGoalInferencePrompt(
  request: GoalInferenceRequest,
): string {
  const lines: string[] = [
    'I replied to an email in a thread that has no recorded goal.',
    'Infer what I want out of this conversation from the reply I sent.',
    'Answer with one sentence in the first person, as if I wrote it.',
    'Describe the outcome I want, not the words I used. No quotes, no explanation.',
  ]

  if (request.topic) lines.push(`Thread topic: ${request.topic}`)

  if (request.incoming) {
    lines.push(
      '',
      'The message I was answering:',
      request.incoming.slice(0, MAX_REVIEW_CHARS),
    )
  }

  lines.push(
    '',
    'The reply I sent:',
    request.sentReply.slice(0, MAX_REVIEW_CHARS),
  )

  return lines.join('\n')
}

/**
 * Turn the model's answer into a goal the app can store.
 *
 * Models answer a one-sentence request with fences, quotes, a "Goal:" label or
 * a short paragraph. Only the first non-empty line is kept, because the column
 * is meant to hold the sentence the user reads and edits, not the model's
 * explanation of it.
 */
export function parseInferredGoal(raw: string): string | null {
  const unfenced = raw.replace(/```[^\n]*\n?/g, '').trim()
  const first = unfenced
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!first) return null

  const text = first
    .replace(/^(?:my\s+)?goal\s*:\s*/i, '')
    .replace(/^["'“]+/, '')
    .replace(/["'”]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return null
  return text.length > MAX_INFERRED_GOAL_LENGTH
    ? text.slice(0, MAX_INFERRED_GOAL_LENGTH).trimEnd()
    : text
}

/**
 * Read the model's JSON back without trusting its formatting.
 *
 * Models fence JSON, prefix it with a sentence, or answer with prose; a strict
 * `JSON.parse` would turn all three into "no answer". The object is located by
 * its braces and validated field by field, so a chatty reply still yields a
 * verdict and a malformed one yields null rather than a guess.
 */
export function parseGoalVerdict(raw: string): GoalVerdict | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }

  const record = parsed as Record<string, unknown>
  if (typeof record.meetsGoal !== 'boolean') return null

  // A met goal has nothing to explain; dropping a reason the model volunteered
  // keeps the view from showing a warning on a reply that was fine.
  if (record.meetsGoal) {
    return { meetsGoal: true, reason: null, suggestion: null }
  }

  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

  return {
    meetsGoal: false,
    reason: text(record.reason),
    suggestion: text(record.suggestion),
  }
}
