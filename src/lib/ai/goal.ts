/**
 * The LLM as a judge of one reply, against one goal.
 *
 * Same transport as the topic generator and the reply drafter, same three
 * providers, same bring-your-own key. What differs is the question: this one
 * does not write a reply first and ask whether it is good — it is handed what
 * the user actually sent and asked whether that moves the thread toward the goal
 * they wrote down.
 *
 * Everything that can be decided without a model — whether there is a goal at
 * all, what the prompt says, how the answer is parsed — lives in
 * `conversation/goal.ts`. This file is the part that needs a key.
 */

import type {
  GoalReviewer,
  GoalReviewRequest,
  GoalVerdict,
} from '#/lib/conversation/index.ts'

import {
  buildGoalReviewPrompt,
  parseGoalVerdict,
  sanitizeDraft,
} from '#/lib/conversation/index.ts'
import { completeLlm, isReasoningModel } from './llm.ts'
import type { LlmConfig } from './llm.ts'

/** A verdict, a reason and a short reply — a few hundred tokens at most. */
const MAX_REVIEW_TOKENS = 700

/** The same budget on a reasoning model, where the hidden thinking is billed first. */
const MAX_REASONING_REVIEW_TOKENS = 4_096

export class LlmGoalReviewer implements GoalReviewer {
  readonly name: string
  private readonly config: LlmConfig

  constructor(config: LlmConfig) {
    this.config = config
    this.name = `llm:${config.provider}`
  }

  async review(request: GoalReviewRequest): Promise<GoalVerdict | null> {
    const raw = await completeLlm(
      this.config,
      buildGoalReviewPrompt(request),
      isReasoningModel(this.config.model)
        ? MAX_REASONING_REVIEW_TOKENS
        : MAX_REVIEW_TOKENS,
    )

    const verdict = parseGoalVerdict(raw)
    if (!verdict || verdict.meetsGoal || !verdict.suggestion) return verdict

    // The suggestion is a body the user may send, so it is cleaned the way a
    // draft is: no fence, no "Reply:" label, and a cap on a runaway answer. The
    // greeting and signature are the send path's job, so neither is stripped.
    return {
      ...verdict,
      suggestion: sanitizeDraft(verdict.suggestion, {
        stripGreeting: false,
        stripSignature: false,
      }),
    }
  }
}

/** The reviewer for a config, or null when no LLM is configured. */
export function goalReviewerFromConfig(
  llm: LlmConfig | null | undefined,
): GoalReviewer | null {
  return llm ? new LlmGoalReviewer(llm) : null
}
