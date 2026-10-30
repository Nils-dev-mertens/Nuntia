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
