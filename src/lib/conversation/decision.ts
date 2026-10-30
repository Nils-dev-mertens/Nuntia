/**
 * The decision layer, split by *owner*.
 *
 * The original shape had one `DecisionLayer.decide()` returning state, importance,
 * urgency, requiresReply, intent and topic together. The fields do not actually
 * share an owner, so that shape could not express what the product wants:
 *
 *   state        rules when they are confident, otherwise Jev
 *   importance   Jev
 *   urgency      Jev
 *   replyable    the user's own mark, then the machine-mail marker, then Jev
 *   topic        an LLM (prose)
 *   intent       the user — never written by a model
 *
 * So it is a small pipeline of three stages rather than one interface:
 *
 *   1. `RuleClassifier`    — deterministic, keyless, always runs
 *   2. `DecisionModel`     — Jev, typed decisions
 *   3. `TopicGenerator`    — an LLM, short prose
 *
 * A keyless install just uses the rule-based defaults below. `decideConversation`
 * runs the stages in order and folds the result into one `Decision`.
 *
 * Jev and the LLM are deliberately separate seams. Jev returns decisions, not
 * text; the LLM writes text, not decisions. They are not swaps for each other.
 */

import type { Conversation, ConversationMessage } from './model.ts'
import type { ConversationState } from '#/db/schema.ts'
import type { ContactDecisionContext } from '#/lib/contacts/context.ts'
import {
  activeImportanceOverride,
  activeStateOverride,
  deriveState,
} from './model.ts'

// Imported by path rather than through `#/lib/ai/index.ts`: the index pulls in
// Jev, the providers and the settings table, and this file must not drag the
// database into anything that imports the pipeline. `ai-log.ts` itself imports
// nothing but `node:fs`.
import { reportAiFailure } from '#/lib/ai/ai-log.ts'
import { isAutomatedThread } from './automated.ts'

export type DecisionInput = {
  subject: string
  /** Newest last. */
  messages: ConversationMessage[]
  ownerEmail: string
  /** The user's own goal for this conversation, when they have set one. */
  goal: string | null
  /** Last time the decision layer ran, if ever. */
  decidedAt: Date | null
  /**
   * The user has filed away mail from this thread's other party before, and has
   * not brought any of it back since.
   *
   * The one *learned* input: it comes from what the user did to other threads
   * from the same sender, not from anything in this one. Absent means nothing
   * has been learned — which is also what a thread with no other party has.
   */
  ignoredSender?: boolean
  /**
   * The user has marked this thread's other party as one they cannot reply to.
   *
   * The second *stored* input, and the authoritative one for replyability: the
   * machine-mail marker only catches senders that say so in their address, and
   * Jev can only guess from the writing. A company whose mail is view-only from
   * an ordinary address is invisible to both, and the user is the only one who
   * knows. Absent means nothing has been marked, which is also what a thread with
   * no other party has.
   */
  unreplyableSender?: boolean
  /** User's own 1–10 importance rating for this correspondent, if set. */
  senderImportance?: number | null
  /** User-authored profile notes for this correspondent, when present. */
  senderContext?: ContactDecisionContext | null
}

/**
 * What the deterministic rules know.
 *
 * `state` is `null` when the rules have no strong signal — that is the gap the
 * decision model fills. The placeholder scores are what a keyless install falls
 * back to; a real model overrides them.
 */
export type RuleFacts = {
  /**
   * The deterministic state, or `null` when the rules have no strong signal.
   *
   * `low-priority` is a claim the rules can make on their own — machine mail and
   * broadcasts are settled without asking a model.
   */
  state: ConversationState | null
  awaitingReply: boolean
  requiresReply: boolean
  /**
   * There is no human on the other side — every message came from the owner or a
   * marked no-reply sender. Replyability's first, deterministic step, and the
   * signal that tells the decision model to leave the question alone.
   */
  isAutomated: boolean
  /**
   * The user has marked this sender as one a reply cannot reach.
   *
   * Settles replyability before the model is asked, the same way `isAutomated`
   * does — the two differ only in who decided, and in that this one is a stored
   * answer rather than something read off the address.
   */
  senderUnreplyable: boolean
  placeholderImportance: number
  placeholderUrgency: number
  reasoning: string
}

/** Stage 1 — deterministic and keyless. Always runs, and wins where it is sure. */
export interface RuleClassifier {
  readonly name: string
  classify: (input: DecisionInput) => RuleFacts
}

/** What the decision model (Jev) contributes. */
export type ModelVerdict = {
  /**
   * Used when the rules returned `null`, and also to *confirm or drop* a rule's
   * `needs-action` — a rule claiming something needs doing is the claim most
   * worth a second opinion, because a false positive is filed as work.
   *
   * Never applied to `waiting-for-reply` or `low-priority`: those the rules can
   * read off the message flow. `null` means "no opinion", and the rule stands.
   */
  state: ConversationState | null
  importance: number
  urgency: number
  /**
   * `null` means "no opinion" — the rule outcome stands. Only asked when the
   * thread has a human on it; machine mail is settled before the model sees it.
   */
  replyable: boolean | null
  reasoning: string | null
}

/** Stage 2 — typed decisions. Jev, or the rule-based placeholder. */
export interface DecisionModel {
  readonly name: string
  decide: (input: DecisionInput, facts: RuleFacts) => Promise<ModelVerdict>
}

/** Stage 3 — prose. An LLM writes the topic label. */
export interface TopicGenerator {
  readonly name: string
  generate: (input: DecisionInput) => Promise<string | null>
}

/** The composed result, in the order the app consumes it. */
export type Decision = {
  /**
   * `low-priority` is reachable from the rules (machine mail, promotions) and
   * from the model's scores. See `HeuristicRuleClassifier` and `foldState`.
   */
  state: ConversationState
  awaitingReply: boolean
  requiresReply: boolean
  /** False hides the composer and shows the "No reply" tag. */
  replyable: boolean
  importance: number
  urgency: number
  /** Topic is an LLM's job; null until one is configured. */
  topic: string | null
  reasoning: string | null
  /** Stage names that ran, in order. Recorded on the `decisions` row. */
  providers: string[]
}

export type DecisionPipeline = {
  rules: RuleClassifier
  model: DecisionModel
  topics: TopicGenerator
}

/**
 * Deterministic rules, wrapping `deriveState`.
 *
 * `informational` is the rules' "no strong signal" bucket, so it is reported as
 * `null` rather than claimed: the decision model is allowed to say something
 * sharper about a thread the rules could only shrug at.
 */
export class HeuristicRuleClassifier implements RuleClassifier {
  readonly name = 'rules'

  classify(input: DecisionInput): RuleFacts {
    const last = input.messages.at(-1)

    const result = deriveState(input.messages, {
      ownerEmail: input.ownerEmail,
      lastMessageAt: last?.sentAt ?? new Date(0),
      now: new Date(),
    })

    const isAutomated = isAutomatedThread(input.messages, input.ownerEmail)

    // The user's own mark on this sender. Read here rather than in the fold so
    // the model's replyability question can be skipped entirely: the user has
    // already answered it, and asking would only invite the model to disagree.
    const senderUnreplyable = input.unreplyableSender === true

    // What the user has taught the app about this sender, applied to a thread
    // they have never answered: mail arriving in one direction only, with
    // nobody asking them anything.
    //
    // The case this exists for is the one-off notice — "your order shipped",
    // "someone viewed your profile" — which is not machine-marked often enough
    // for the marker to catch it, and which nobody wants to be told about
    // twice. A question survives it: if there is something to answer, the
    // thread is work again whatever the sender's history is.
    const learnedLowPriority =
      input.ignoredSender === true &&
      input.messages.every((message) => !message.isFromOwner) &&
      !result.requiresReply

    // Three deterministic routes into `low-priority`, all keyless:
    //
    // - Machine mail is not a conversation. Nothing is expected of the reader and
    //   the thread is never replyable, so "a receipt landed" is not work.
    // - A broadcast promotion is not addressed to the reader either. Its "?" is a
    //   call to action ("Do you want to save 20%?"), and that is what used to file
    //   marketing mail under Needs action.
    // - A sender the user has already filed away, writing a one-way notice. This
    //   is the app applying their own earlier judgement, so that the same mail
    //   only has to be dismissed once to stop coming back.
    //
    // None of them asks the model: the rules can justify all three, and the cost
    // of being wrong is low — the thread is still listed, still readable, still
    // replyable when a human wrote it.
    const lowPriority =
      isAutomated ||
      (result.state !== 'waiting-for-reply' && result.intent === 'promotion') ||
      learnedLowPriority

    // `informational` is the rules' "no strong signal" bucket, so it is reported
    // as `null` rather than claimed: the model is allowed to say something
    // sharper about a thread the rules could only shrug at.
    const state: ConversationState | null = lowPriority
      ? 'low-priority'
      : result.state === 'informational'
        ? null
        : result.state

    const reasoning = !last
      ? 'Empty conversation.'
      : lowPriority
        ? isAutomated
          ? 'Machine mail; nothing here is written to you.'
          : learnedLowPriority
            ? 'You have filed away mail from this sender before.'
            : 'A bulk promotion; nobody is asking you for anything.'
        : last.isFromOwner
          ? 'You sent the last message; waiting on a reply.'
          : result.requiresReply
            ? 'The last message asks you a direct question.'
            : 'Last message was informational.'

    return {
      state,
      awaitingReply: result.awaitingReply,
      requiresReply: result.requiresReply,
      isAutomated,
      senderUnreplyable,
      placeholderImportance: result.importance,
      placeholderUrgency: result.urgency,
      reasoning,
    }
  }
}

/**
 * Keyless fallback for the decision model.
 *
 * Returns the rule placeholders and never claims a state of its own. Exists so
 * the pipeline is whole before Jev is wired in, and so an install with no Jev key
 * still behaves exactly as it does today.
 */
export class PlaceholderDecisionModel implements DecisionModel {
  readonly name = 'rules'

  async decide(_input: DecisionInput, facts: RuleFacts): Promise<ModelVerdict> {
    return {
      state: null,
      importance: facts.placeholderImportance,
      urgency: facts.placeholderUrgency,
      replyable: null,
      reasoning: null,
    }
  }
}

/** Keyless fallback for the topic stage: no topic. */
export class NoTopicGenerator implements TopicGenerator {
  readonly name = 'none'

  async generate(): Promise<string | null> {
    return null
  }
}

/** The all-rules pipeline used when no AI service is configured. */
export function defaultDecisionPipeline(): DecisionPipeline {
  return {
    rules: new HeuristicRuleClassifier(),
    model: new PlaceholderDecisionModel(),
    topics: new NoTopicGenerator(),
  }
}

/**
 * Run the pipeline and fold the stages into one decision.
 *
 * The rules decide the state when they are confident; otherwise the decision
 * model does. Importance/urgency come from the model (the placeholders when there
 * is none). Topic comes from the generator. `intent` is deliberately absent — it
 * is the user's to set.
 */
export async function decideConversation(
  input: DecisionInput,
  pipeline: DecisionPipeline = defaultDecisionPipeline(),
): Promise<Decision> {
  const facts = pipeline.rules.classify(input)

  // The AI stages are optional and independently configured, so a failure in
  // either must degrade to the deterministic answer rather than reject. The
  // callers persist the conversation around this call (`decideAndSave`), so a
  // provider that is down, rate limited, or misconfigured (a stale model name,
  // a rejected parameter) must not stop a synced thread from being saved —
  // otherwise the inbox silently stops showing new mail.
  const verdict = await safeDecide(pipeline.model, input, facts)
  const topic = await safeGenerateTopic(pipeline.topics, input)

  return {
    state: foldState(facts, verdict),
    awaitingReply: facts.awaitingReply,
    requiresReply: facts.requiresReply,
    // Machine mail is settled by the marker and cannot be talked back into being
    // replyable; otherwise the model may downgrade it, and defaults to yes. The
    // user's own mark settles it too, and for the same reason — it is an answer
    // rather than a hint, and a re-decide must not reach a different one.
    replyable:
      facts.isAutomated || facts.senderUnreplyable
        ? false
        : (verdict.replyable ?? true),
    importance: verdict.importance,
    urgency: verdict.urgency,
    topic,
    reasoning: verdict.reasoning ?? facts.reasoning,
    providers: [pipeline.rules.name, pipeline.model.name, pipeline.topics.name],
  }
}

/**
 * Fold the rule facts and the model verdict into one state.
 *
 * Three cases, in order:
 *
 * 1. The rules are certain (`waiting-for-reply`, `low-priority`) — the answer is
 *    readable from the message flow, so nothing overrides it.
 * 2. Otherwise — the rules abstained, or claimed `needs-action` — the model's
 *    answer wins when it gave one. A rule can only ever *add* work, and "a `?`
 *    in the body" is a weaker signal than a model reading the thread, so the
 *    false positives it produces are exactly the threads worth a second
 *    opinion. A `null` verdict (no model, no answer) keeps the rule.
 *
 * An `informational` verdict still needs nothing, so when the model *also* scored
 * both importance and urgency at the bottom of its rubric the thread is moved to
 * `low-priority` — "nothing to do" and "not worth your time now" are different
 * answers, and only the second one keeps the inbox quiet.
 */
function foldState(facts: RuleFacts, verdict: ModelVerdict): ConversationState {
  if (facts.state === 'waiting-for-reply' || facts.state === 'low-priority') {
    return facts.state
  }

  const state = verdict.state ?? facts.state ?? 'informational'
  if (state !== 'informational') return state

  return isTrivial(verdict) ? 'low-priority' : 'informational'
}

/** The model's own scores say the thread is barely worth opening. */
function isTrivial(verdict: ModelVerdict): boolean {
  return verdict.importance <= 3 && verdict.urgency <= 3
}

/** Run the decision model, falling back to the rule placeholders on failure. */
async function safeDecide(
  model: DecisionModel,
  input: DecisionInput,
  facts: RuleFacts,
): Promise<ModelVerdict> {
  try {
    return await model.decide(input, facts)
  } catch (error) {
    // Logged to the file as well as the terminal: a failure the rules paper over
    // is exactly the one nobody notices until they ask why nothing happened.
    await reportAiFailure(
      model.name,
      error,
      'failed; using rules for this conversation',
    )
    return {
      state: null,
      importance: facts.placeholderImportance,
      urgency: facts.placeholderUrgency,
      replyable: null,
      reasoning: null,
    }
  }
}

/** Generate the topic label, or null when the generator fails. */
async function safeGenerateTopic(
  topics: TopicGenerator,
  input: DecisionInput,
): Promise<string | null> {
  try {
    return await topics.generate(input)
  } catch (error) {
    await reportAiFailure(
      topics.name,
      error,
      'failed; this conversation gets no topic',
    )
    return null
  }
}

/**
 * Apply a decision to a conversation.
 *
 * `goal` and `intent` are user-owned and are never written here — the user is the
 * source of truth for what a thread means to them, and a decision layer has no
 * business overwriting either.
 *
 * `state` joins them in that respect: the user's own call outranks the pipeline,
 * which is the whole point of storing it. A call the thread has outrun is dropped
 * rather than kept — it no longer affects the state, and leaving it on the row
 * would make an expired judgement look current to the next reader.
 */
export function applyDecision(
  conversation: Conversation,
  decision: Decision,
): Conversation {
  const override = activeStateOverride(conversation)
  // The score is the user's for the same reason, and it is cleared on the same
  // terms: one the thread has outrun is dropped rather than left on the row, so
  // the next reader cannot mistake an expired judgement for a current one.
  const importanceOverride = activeImportanceOverride(conversation)

  return {
    ...conversation,
    state: override ?? decision.state,
    stateOverride: override ? conversation.stateOverride : null,
    awaitingReply: decision.awaitingReply,
    replyable: decision.replyable,
    importance: importanceOverride ?? decision.importance,
    importanceOverride:
      importanceOverride === null ? null : conversation.importanceOverride,
    urgency: decision.urgency,
    requiresReply: decision.requiresReply,
    // Only fill the topic if the user has not set one.
    topic: conversation.topic ?? decision.topic,
  }
}
