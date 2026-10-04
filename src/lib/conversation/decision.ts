/**
 * Decision layer.
 *
 * The spec calls for AI that classifies conversations into state, importance and
 * urgency. That layer is not built yet (see PLAN.md — Jev was two weeks old at
 * time of writing, so it sits behind this interface).
 *
 * What matters now is that the interface is stable: `model.ts` never imports a
 * concrete decision engine, so swapping the rule-based implementation for an
 * LLM-backed one must not touch anything upstream.
 */

import type { Conversation, ConversationMessage } from './model.ts'
import type { ConversationState, Intent } from '#/db/schema.ts'

/** What a decision layer must return. */
export type Decision = {
  state: ConversationState
  importance: number
  urgency: number
  requiresReply: boolean
  intent: Intent
  /** Short description of what the conversation is currently about. */
  currentTopic: string | null
  /** Why the layer decided this — surfaced in the UI for trust. */
  reasoning: string | null
  /** Which implementation produced this, recorded on the decisions table. */
  provider: string
}

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

export interface DecisionLayer {
  readonly name: string
  decide: (input: DecisionInput) => Promise<Decision>
}

/**
 * Rule-based implementation.
 *
 * Wraps `deriveState` from the model so the interface is exercised today. This
 * is the thing that gets replaced; everything else stays.
 */
export class RuleBasedDecisionLayer implements DecisionLayer {
  readonly name = 'rules'

  async decide(input: DecisionInput): Promise<Decision> {
    // Imported lazily to keep the module graph acyclic: model.ts imports
    // decision types, and this would otherwise be circular.
    const { deriveState } = await import('./model.ts')

    const last = input.messages.at(-1)
    const now = last?.sentAt ?? new Date()

    const result = deriveState(input.messages, {
      ownerEmail: input.ownerEmail,
      lastMessageAt: last?.sentAt ?? new Date(0),
      now,
    })

    return {
      state: result.state,
      importance: result.importance,
      urgency: result.urgency,
      requiresReply: result.requiresReply,
      intent: result.intent,
      // Topic is left to the user for now. Guessing it from the subject would
      // produce "Re: Project launch" noise.
      currentTopic: null,
      reasoning: last
        ? last.isFromOwner
          ? 'You sent the last message; waiting on a reply.'
          : result.requiresReply
            ? 'The last message asks you a direct question.'
            : 'Last message was informational.'
        : 'Empty conversation.',
      provider: this.name,
    }
  }
}

/**
 * No-op layer used before any LLM is configured.
 *
 * Keeps the app functional with no API keys set, which matters for local dev.
 */
export class NoopDecisionLayer implements DecisionLayer {
  readonly name = 'noop'

  async decide(_input: DecisionInput): Promise<Decision> {
    return {
      state: 'informational',
      importance: 5,
      urgency: 5,
      requiresReply: false,
      intent: 'unknown',
      currentTopic: null,
      reasoning: null,
      provider: this.name,
    }
  }
}

/**
 * Apply a decision to a conversation.
 *
 * The user's `goal` is never touched — it is their source of truth for intent,
 * and the decision layer has no business overwriting it.
 */
export function applyDecision(
  conversation: Conversation,
  decision: Decision,
): Conversation {
  return {
    ...conversation,
    state: decision.state,
    importance: decision.importance,
    urgency: decision.urgency,
    requiresReply: decision.requiresReply,
    intent: decision.intent,
    // Only fill the topic if the user has not set one.
    topic: conversation.topic ?? decision.currentTopic,
    goal: conversation.goal,
  }
}