/**
 * Jev — TypeSafe's System One decision model.
 *
 * This is the `DecisionModel` seam: importance, urgency, and a state to fill in
 * when the deterministic rules could not determine one. It returns *decisions*,
 * not prose — typed answers with calibrated probabilities — so it is not a swap
 * for the LLM topic generator.
 *
 * API shape (docs.typesafe.ai/api):
 *
 *   POST https://api.typesafe.ai/v1/systemone
 *   { state, model, questions: { <id>: Question } }
 *   -> { model, answers: { <id>: Answer }, usage }
 *
 * `noul` is yes/no (probability 0..1), `choice` picks one option, `score` rates
 * along an ordered rubric and returns a probability-weighted value across it.
 */

import type {
  DecisionInput,
  DecisionModel,
  ModelVerdict,
  RuleFacts,
} from '#/lib/conversation/index.ts'
import type { ConversationState } from '#/db/schema.ts'

import { asRecord, isRecord, postJson } from './http.ts'
import type { FetchLike } from './http.ts'

export type JevConfig = {
  apiKey: string
  model: string
  fetchImpl?: FetchLike
}

const SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone'

/** Ten levels so the probability-weighted score maps cleanly onto 1..10. */
const IMPORTANCE_LEVELS = [
  'Trivial — no consequence either way',
  'Very low — barely worth noting',
  'Low — mild interest at most',
  'Somewhat low — nice to know',
  'Moderate — worth a look',
  'Somewhat high — deserves attention',
  'High — clearly matters',
  'Very high — important to the recipient',
  'Critical — significant consequences',
  'Vital — cannot be missed',
]

const URGENCY_LEVELS = [
  'No time pressure at all',
  'Could wait indefinitely',
  'Not urgent — whenever there is time',
  'Slightly time-sensitive',
  'Should be handled soon',
  'Moderately urgent',
  'Urgent — today or tomorrow',
  'Very urgent — within hours',
  'Extremely urgent — immediately',
  'Critical — every minute counts',
]

/** How much of the thread Jev sees, and the cap on the whole state string. */
const MAX_MESSAGES = 10
const MAX_MESSAGE_CHARS = 1_000
const MAX_STATE_CHARS = 8_000

export class JevDecisionModel implements DecisionModel {
  readonly name = 'jev'
  private readonly config: JevConfig

  constructor(config: JevConfig) {
    this.config = config
  }

  async decide(input: DecisionInput, facts: RuleFacts): Promise<ModelVerdict> {
    const questions: Record<string, unknown> = {
      importance: {
        type: 'score',
        instructions: 'How important is this conversation to the recipient?',
        criteria: IMPORTANCE_LEVELS,
      },
      urgency: {
        type: 'score',
        instructions: 'How urgently does this conversation need the recipient?',
        criteria: URGENCY_LEVELS,
      },
    }

    // Only ask about state when the rules could not decide it — the whole point
    // of "rules first, Jev fills the gap". A confident rule is never overridden.
    if (facts.state === null) {
      questions.state = {
        type: 'choice',
        instructions: 'What does this conversation need from the recipient?',
        criteria: {
          'needs-action': 'A reply or a decision is expected from the recipient',
          informational: 'No action expected; it is there to be read',
        },
      }
    }

    // Machine mail is settled by the deterministic marker before Jev runs, so the
    // model is only asked about threads a human could actually answer. A letter
    // from a person with no return address is the case this catches.
    if (!facts.isAutomated) {
      questions.replyable = {
        type: 'choice',
        instructions:
          'Can the recipient actually reply to this message? Choose "replyable" only if a reply would reach someone.',
        criteria: {
          replyable: 'A reply would reach a person and is welcome',
          'no-reply':
            'Nobody can or should reply — a broadcast, a notice, or a letter with no return address',
        },
      }
    }

    const json = asRecord(
      await postJson({
        url: SYSTEMONE_URL,
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        body: {
          state: stateText(input),
          model: this.config.model,
          questions,
        },
        fetchImpl: this.config.fetchImpl,
      }),
      'Jev response',
    )

    const answers = isRecord(json.answers) ? json.answers : {}

    const importance = scoreToTen(answers.importance) ?? facts.placeholderImportance
    const urgency = scoreToTen(answers.urgency) ?? facts.placeholderUrgency
    // The model's state is only meaningful when the rules abstained.
    const state = facts.state === null ? choiceState(answers.state) : null
    // `null` when the question was not asked (machine mail) or unanswered, and
    // the fold then keeps the rule outcome.
    const replyable = choiceReplyable(answers.replyable)

    return {
      state,
      importance,
      urgency,
      replyable,
      reasoning: `Jev scored importance ${importance}/10 and urgency ${urgency}/10.`,
    }
  }
}

/**
 * A compact transcript for the model.
 *
 * Jev keys off structured state, so a `Subject:` line plus the last few turns is
 * the useful shape. Bounded on both axes because the input is billed by token and
 * a long thread should not become an expensive call.
 */
function stateText(input: DecisionInput): string {
  const lines: string[] = [`Subject: ${input.subject}`]
  if (input.goal) lines.push(`The recipient's goal: ${input.goal}`)

  for (const message of input.messages.slice(-MAX_MESSAGES)) {
    const who = message.isFromOwner
      ? 'Me'
      : (message.from.name ?? message.from.email)
    lines.push(`${who}: ${message.body.slice(0, MAX_MESSAGE_CHARS)}`)
  }

  return lines.join('\n').slice(0, MAX_STATE_CHARS)
}

/**
 * Map a `score` answer onto 1..10.
 *
 * A ten-level rubric returns a probability-weighted value across indices 0..9, so
 * the nearest index shifted by one is a 1..10 score. Anything malformed yields
 * `null`, and the caller falls back to the rule placeholder.
 */
function scoreToTen(answer: unknown): number | null {
  if (!isRecord(answer)) return null
  if (answer.type !== 'score' || typeof answer.score !== 'number') return null
  if (!Number.isFinite(answer.score)) return null

  return Math.min(10, Math.max(1, Math.round(answer.score) + 1))
}

/** Map a `choice` answer onto the two states a rule could not decide. */
function choiceState(answer: unknown): ConversationState | null {
  if (!isRecord(answer)) return null
  if (answer.type !== 'choice' || typeof answer.choice !== 'string') return null

  return answer.choice === 'needs-action' ? 'needs-action' : 'informational'
}

/** Map the replyability `choice` onto a verdict; `null` means "no answer". */
function choiceReplyable(answer: unknown): boolean | null {
  if (!isRecord(answer)) return null
  if (answer.type !== 'choice' || typeof answer.choice !== 'string') return null

  return answer.choice === 'replyable'
}
