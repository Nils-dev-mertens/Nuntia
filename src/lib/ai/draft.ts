/**
 * The LLM as a reply drafter.
 *
 * The same transport as the topic generator (`completeLlm`), the same three
 * providers, and the same bring-your-own key — what differs is the prompt, the
 * budget, and the fact that this one is only ever called on demand, for one
 * conversation, when `replyDraftEligibility` says a draft is worth generating.
 *
 * The output is a *draft*: text that goes into the composer for the user to
 * review, edit and send. Nothing here sends, and nothing here retries into a
 * send.
 *
 * Everything this module decides is prose; everything about whether to ask at
 * all lives in `conversation/draft.ts`, which is pure and testable. This file is
 * the part that needs a key.
 */

import type {
  ReplyDrafter,
  ReplyDraftRequest,
} from '#/lib/conversation/index.ts'

import {
  buildReplyDraftPrompt,
  sanitizeDraft,
} from '#/lib/conversation/index.ts'
import { completeLlm, isReasoningModel } from './llm.ts'
import type { LlmConfig } from './llm.ts'

/**
 * Completion budget for a reply body.
 *
 * A reply is a few paragraphs at most, so this is generous for a normal model
 * and still an order of magnitude below anything that would be a runaway.
 */
const MAX_DRAFT_TOKENS = 1_024

/**
 * The same budget on a reasoning model.
 *
 * Those models spend `max_completion_tokens` on hidden thinking before writing a
 * word, and a draft needs far more room than a label: the reasoning allowance
 * plus a body.
 */
const MAX_REASONING_DRAFT_TOKENS = 8_192

export class LlmReplyDrafter implements ReplyDrafter {
  readonly name: string
  private readonly config: LlmConfig

  constructor(config: LlmConfig) {
    this.config = config
    this.name = `llm:${config.provider}`
  }

  async draft(request: ReplyDraftRequest): Promise<string | null> {
    const raw = await completeLlm(
      this.config,
      buildReplyDraftPrompt(request),
      isReasoningModel(this.config.model)
        ? MAX_REASONING_DRAFT_TOKENS
        : MAX_DRAFT_TOKENS,
    )

    // Strip a greeting or signature the model wrote despite being told not to —
    // but only the one the send path is about to add anyway. When it will add
    // neither, a draft without either is a reply with no salutation at all.
    return sanitizeDraft(raw, {
      stripGreeting: request.greeting !== null,
      stripSignature: request.signature !== null,
    })
  }
}

/**
 * The drafter for a config, or null when no LLM is configured.
 *
 * Pure, so "no key means no draft and no call" is testable without a database —
 * the same shape `pipelineFromConfig` has for the decision pipeline.
 */
export function replyDrafterFromConfig(
  llm: LlmConfig | null | undefined,
): ReplyDrafter | null {
  return llm ? new LlmReplyDrafter(llm) : null
}
