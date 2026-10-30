/**
 * The generation layer's second job: a reply *draft*.
 *
 * `decision.ts` splits the AI by owner, and its third stage (`TopicGenerator`)
 * writes a label. This is the other piece of prose — a reply the user could
 * send — and it is deliberately kept out of the pipeline: the pipeline runs on
 * every sync, while a draft is generated on demand, for one conversation, only
 * when the conditions below hold.
 *
 * Three things live here, and all three are pure so they can be tested without
 * a key, a network or a database:
 *
 *   - `replyDraftEligibility` — the application-defined conditions the spec asks
 *     for, in one place, so the button the user sees and the guard the server
 *     applies cannot disagree;
 *   - `buildReplyDraftPrompt` — the context the model receives (history, topic,
 *     goal, who it is replying to, the user's own instructions);
 *   - `sanitizeDraft` — the model's output turned back into a body.
 *
 * What is never here: sending. A draft is text in a box the user reviews, and
 * the composer's Send is the only thing that sends.
 */

import { stripGreeting, stripSignature } from '#/lib/mail/strip.ts'

/** One message, reduced to what the model needs to read. */
export type ReplyDraftMessage = {
  /** `Sarah`, `Sarah <sarah@example.com>`, or `Me`. */
  speaker: string
  isFromOwner: boolean
  /** ISO string, so the request crosses a loader boundary unchanged. */
  sentAt: string
  body: string
}

/** Everything one draft is generated from. */
export type ReplyDraftRequest = {
  subject: string
  /** The user's topic for this conversation, when they have one. */
  topic: string | null
  /**
   * The user's goal — the closest thing there is to an instruction, which is why
   * the prompt calls it one rather than presenting it as context.
   */
  goal: string | null
  /** The other party, for the "reply to" line. */
  recipient: { name: string | null; email: string } | null
  /** The mailbox the reply leaves from. */
  ownerEmail: string
  /** Oldest first. */
  messages: ReplyDraftMessage[]
  /**
   * The greeting the send path will put on top of this body, if any.
   *
   * Carried so the model is told not to write one and the sanitiser knows it is
   * safe to drop one it wrote anyway: the same text added twice is the most
   * obvious way a generated reply looks generated.
   */
  greeting: string | null
  /** The signature the send path will append, with the same two consequences. */
  signature: string | null
  /** Anything the user typed for this draft alone. */
  instructions: string | null
}

/**
 * Stage 4 of the AI layer: prose, on demand.
 *
 * Separate from `TopicGenerator` because the two are called at different times
 * for different reasons — a topic is derived once per sync, a draft only when
 * the user asks — and because a drafter that is not configured must be able to
 * answer "no draft" without the caller special-casing it.
 */
export interface ReplyDrafter {
  readonly name: string
  draft: (request: ReplyDraftRequest) => Promise<string | null>
}

/** The keyless default: no draft, no failure, nothing to explain. */
export class NoReplyDrafter implements ReplyDrafter {
  readonly name = 'none'

  async draft(): Promise<string | null> {
    return null
  }
}

/** Importance at which a draft is worth generating unless the user says otherwise. */
export const REPLY_DRAFT_MIN_IMPORTANCE_DEFAULT = 6

/** The setting is a 1–10 score, like the one it is compared against. */
export const REPLY_DRAFT_MIN_IMPORTANCE_MIN = 1
export const REPLY_DRAFT_MIN_IMPORTANCE_MAX = 10

/** How much of the thread the model sees: enough for a reply, not a whole mailbox. */
const MAX_DRAFT_MESSAGES = 8
const MAX_DRAFT_MESSAGE_CHARS = 1_200

/**
 * Cap on the draft itself.
 *
 * Well above a normal reply, so it only ever bites on a runaway model — and then
 * it truncates rather than returning nothing, because a long draft the user can
 * edit beats an empty panel.
 */
const MAX_DRAFT_CHARS = 4_000

/** Longest user instruction the prompt will carry. */
const MAX_INSTRUCTIONS_CHARS = 500

/**
 * Why no draft was offered, or offered at all.
 *
 * `detail` is a full sentence rather than a code for the same reason the rest of
 * the app states its reasoning: the control's absence is otherwise unexplained,
 * and "importance 4/10, drafts start at 6" is a much better answer than a
 * missing button.
 */
export type DraftSkipReason =
  'no-model' | 'unreplyable' | 'already-answered' | 'not-important-enough'

export type DraftEligibility =
  | { eligible: true; reason: null; detail: null }
  | { eligible: false; reason: DraftSkipReason; detail: string }

/**
 * Should a draft be generated for this conversation?
 *
 * A draft no longer waits for the newest message to ask for something. The
 * user's goal is the reason to write, and a reply that only moves a thread
 * forward — a nudge, a confirmation, a question of their own — is exactly what a
 * goal needs. What remains is whether there is a model to write it, a person a
 * reply can reach, whether the user already spoke last, and whether the thread
 * matters enough to spend a call on.
 *
 * Order matters, because only the first failure is reported. The model comes
 * first (with no key the feature is simply off, and no thread-level fact
 * explains that), then the reasons that are about the thread.
 *
 * Used by the loader — to decide whether to show the control, and to explain
 * itself when not — *and* by the action, because the button is not a promise the
 * server has to keep: mail arrives, marks change, and the stored row is the only
 * thing that settles it.
 */
export function replyDraftEligibility(input: {
  /** An LLM key and provider are stored. */
  modelConfigured: boolean
  /** A reply can reach somebody on this thread. */
  replyable: boolean
  /** The user spoke last, so the ball is in the other court. */
  awaitingReply: boolean
  /** 1–10, as the decision layer scored it. */
  importance: number
  /** The user's threshold, from Settings. */
  minImportance: number
}): DraftEligibility {
  if (!input.modelConfigured) {
    return {
      eligible: false,
      reason: 'no-model',
      detail: 'No LLM key is configured, so there is nothing to draft with.',
    }
  }

  if (!input.replyable) {
    return {
      eligible: false,
      reason: 'unreplyable',
      detail: 'There is nobody on this thread a reply can reach.',
    }
  }

  if (input.awaitingReply) {
    return {
      eligible: false,
      reason: 'already-answered',
      detail: 'You sent the last message, so there is nothing to answer.',
    }
  }

  if (input.importance < input.minImportance) {
    return {
      eligible: false,
      reason: 'not-important-enough',
      detail: `Importance ${input.importance}/10 — drafts start at ${input.minImportance}.`,
    }
  }

  return { eligible: true, reason: null, detail: null }
}

/** The name shown for one participant, so the model can tell the sides apart. */
function speakerOf(message: ReplyDraftMessage, ownerEmail: string): string {
  if (message.isFromOwner) return 'Me'
  return message.speaker || ownerEmail
}

/**
 * The prompt, shared by every provider.
 *
 * Written as instructions to a person rather than a template: the model is
 * asked for a message *body*, told what the send path adds and therefore what it
 * must not write, and given the thread newest-last so the reply answers the
 * newest message.
 */
export function buildReplyDraftPrompt(request: ReplyDraftRequest): string {
  const lines: string[] = []

  lines.push(
    'Write the body of my reply to the newest message in this email thread.',
    'Write as me, in the first person, matching the tone of the thread.',
    'Keep it to a few short sentences unless the message clearly needs more.',
  )

  // Only claim what the send path will actually do: telling the model a greeting
  // is added when none is would invite it to answer without one.
  if (request.greeting) {
    lines.push(
      `Do not write a greeting — "${request.greeting}" is added automatically.`,
    )
  }
  if (request.signature) {
    lines.push(
      'Do not write a sign-off or signature — it is added automatically.',
    )
  }
  if (!request.greeting && !request.signature) {
    lines.push('Do not write a greeting or a sign-off.')
  }

  lines.push(
    'Answer only what is asked, ask nothing in return unless the reply needs it,',
    'and do not invent facts, dates, prices or commitments I did not state.',
    'Reply with the message body only: no subject line, no quotes, no markdown.',
  )

  if (request.goal) {
    lines.push('', `What I want out of this conversation: ${request.goal}`)
  }
  if (request.topic) {
    lines.push(`What it is about: ${request.topic}`)
  }
  if (request.instructions) {
    const instructions = request.instructions.slice(0, MAX_INSTRUCTIONS_CHARS)
    lines.push('', `Extra instruction from me for this reply: ${instructions}`)
  }

  lines.push('', `Subject: ${request.subject}`)
  lines.push(
    `Replying to: ${request.recipient ? formatRecipient(request.recipient) : 'the thread'}`,
  )

  lines.push('', 'The thread so far, oldest first:')
  for (const message of request.messages.slice(-MAX_DRAFT_MESSAGES)) {
    const body = message.body.slice(0, MAX_DRAFT_MESSAGE_CHARS)
    lines.push(`${speakerOf(message, request.ownerEmail)}: ${body}`)
  }

  return lines.join('\n')
}

function formatRecipient(recipient: {
  name: string | null
  email: string
}): string {
  return recipient.name
    ? `${recipient.name} <${recipient.email}>`
    : recipient.email
}

/** Fences, and the label a model likes to put above its answer. */
const FENCE_START = /^```[^\n]*\n?/
const FENCE_END = /```\s*$/
const LEADING_LABEL = /^(?:draft|reply|suggested reply|message)\s*:\s*\n?/i

/**
 * Turn the model's output into a body the composer can hold.
 *
 * The failure this exists for is a draft that *looks* generated: a fenced block,
 * a "Draft:" header, surrounding quotes, or — the one that matters — a greeting
 * and signature the model wrote anyway. The send path adds the user's own, so a
 * model-written one would be the second of each in the delivered mail. Both are
 * detected with the *same* functions the parser uses on incoming mail, which
 * means a draft is cleaned by the rules the app already trusts.
 *
 * Stripping a greeting and signature is conditional rather than unconditional:
 * when the send path will not add one, a draft without either is a reply that
 * opens with no salutation at all, which is worse than one that repeats itself.
 */
export function sanitizeDraft(
  raw: string,
  options: { stripGreeting: boolean; stripSignature: boolean },
): string | null {
  let text = raw.trim()
  if (!text) return null

  text = text.replace(FENCE_START, '').replace(FENCE_END, '').trim()
  text = text.replace(LEADING_LABEL, '').trim()
  text = unquoteWhole(text)

  if (options.stripGreeting) text = stripGreeting(text).body
  if (options.stripSignature) text = stripSignature(text).body

  text = text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    // Three or more newlines is always an artifact of the model, never spacing
    // the user chose.
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!text) return null
  return text.length > MAX_DRAFT_CHARS
    ? text.slice(0, MAX_DRAFT_CHARS).trimEnd()
    : text
}

/**
 * Remove one matched pair of quotes around the whole message.
 *
 * Only when the text opens and closes with the same style *and* carries no other
 * double quote: a reply quoting somebody else ("she said \"no\"") must not lose
 * its opening character to a sanitiser that thought it was a wrapper.
 */
function unquoteWhole(text: string): string {
  const pairs: Array<[RegExp, RegExp, string]> = [
    [/^"/, /"$/, '"'],
    [/^“/, /”$/, '”'],
  ]

  for (const [open, close, mark] of pairs) {
    if (!open.test(text) || !close.test(text) || text.length < 3) continue
    const inner = text.slice(1, -1)
    if (inner.includes(mark)) continue
    return inner.trim()
  }

  return text
}
