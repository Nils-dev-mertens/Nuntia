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
 *   replyable    the machine-mail marker first, then Jev
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
import { deriveState } from './model.ts'
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
}

/**
 * What the deterministic rules know.
 *
 * `state` is `null` when the rules have no strong signal — that is the gap the
 * decision model fills. The placeholder scores are what a keyless install falls
 * back to; a real model overrides them.
 */
export type RuleFacts = {
  state: ConversationState | null
  awaitingReply: boolean
  requiresReply: boolean
  /**
   * There is no human on the other side — every message came from the owner or a
   * marked no-reply sender. Replyability's first, deterministic step, and the
   * signal that tells the decision model to leave the question alone.
   */
  isAutomated: boolean
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
   * Used only when the rules returned `null`. A confident rule is never
   * overridden.
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

    const reasoning = !last
      ? 'Empty conversation.'
      : last.isFromOwner
        ? 'You sent the last message; waiting on a reply.'
        : result.requiresReply
          ? 'The last message asks you a direct question.'
          : 'Last message was informational.'

    return {
      state: result.state === 'informational' ? null : result.state,
      awaitingReply: result.awaitingReply,
      requiresReply: result.requiresReply,
      isAutomated: isAutomatedThread(input.messages, input.ownerEmail),
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
    state: facts.state ?? verdict.state ?? 'informational',
    awaitingReply: facts.awaitingReply,
    requiresReply: facts.requiresReply,
    // Machine mail is settled by the marker and cannot be talked back into being
    // replyable; otherwise the model may downgrade it, and defaults to yes.
    replyable: facts.isAutomated ? false : (verdict.replyable ?? true),
    importance: verdict.importance,
    urgency: verdict.urgency,
    topic,
    reasoning: verdict.reasoning ?? facts.reasoning,
    providers: [pipeline.rules.name, pipeline.model.name, pipeline.topics.name],
  }
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
    console.error(
      `[decision] model "${model.name}" failed; using rules: ${String(error)}`,
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
    console.error(
      `[decision] topic generator "${topics.name}" failed: ${String(error)}`,
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
 */
export function applyDecision(
  conversation: Conversation,
  decision: Decision,
): Conversation {
  return {
    ...conversation,
    state: decision.state,
    awaitingReply: decision.awaitingReply,
    replyable: decision.replyable,
    importance: decision.importance,
    urgency: decision.urgency,
    requiresReply: decision.requiresReply,
    // Only fill the topic if the user has not set one.
    topic: conversation.topic ?? decision.topic,
  }
}
