/**
 * AI services, composed from the saved settings.
 *
 * Both services are **optional and independently configured in the UI**:
 *
 *   Jev          → the decision model (importance, urgency, a state to fill)
 *   LLM provider → the topic generator (prose)
 *
 * `pipelineFromConfig` is the pure part and is what tests exercise.
 * `loadDecisionPipeline` reads one user's settings row from the database; when
 * nothing is configured — or the settings cannot be read — it returns the
 * all-rules pipeline, so the app behaves exactly as it did before any key was
 * set. That is the "degrades per service" contract, not an error state.
 *
 * The user id is always passed in rather than read from a session here, so the
 * whole layer stays usable from a script or a test without a request.
 */

import {
  defaultDecisionPipeline,
  NoTopicGenerator,
  PlaceholderDecisionModel,
  REPLY_DRAFT_MIN_IMPORTANCE_DEFAULT,
} from '#/lib/conversation/index.ts'
import type {
  DecisionPipeline,
  ReplyDrafter,
} from '#/lib/conversation/index.ts'

import { replyDrafterFromConfig } from './draft.ts'
import { JevDecisionModel } from './jev.ts'
import { LlmTopicGenerator } from './llm.ts'
import { getAiPipelineConfig } from './settings.ts'
import type { AiPipelineConfig } from './settings.ts'

export { JevDecisionModel } from './jev.ts'
export type { JevConfig } from './jev.ts'
export { LlmReplyDrafter, replyDrafterFromConfig } from './draft.ts'
export {
  completeLlm,
  DEFAULT_LLM_MODELS,
  isReasoningModel,
  LLM_PROVIDERS,
  LlmTopicGenerator,
  sanitizeTopic,
} from './llm.ts'
export type { LlmConfig, LlmProvider } from './llm.ts'
export { AiRequestError, postJson } from './http.ts'
export type { FetchLike, JsonRetryPolicy } from './http.ts'
export { aiLogPath, readRecentAiEvents } from './ai-log.ts'
export type { AiLogEntry, AiLogOutcome, AiLogRecord } from './ai-log.ts'
export {
  getAiPipelineConfig,
  getAiSettings,
  normaliseMinImportance,
  saveAiSettings,
} from './settings.ts'
export type {
  AiPipelineConfig,
  AiSettingsInput,
  AiSettingsSummary,
} from './settings.ts'

/**
 * Compose the pipeline from a config. Pure: no environment, no database.
 *
 * Rules always run; the decision model and topic generator are swapped in only
 * when configured.
 */
export function pipelineFromConfig(config: AiPipelineConfig): DecisionPipeline {
  const base = defaultDecisionPipeline()

  return {
    rules: base.rules,
    model: config.jev
      ? new JevDecisionModel(config.jev)
      : new PlaceholderDecisionModel(),
    topics: config.llm
      ? new LlmTopicGenerator(config.llm)
      : new NoTopicGenerator(),
  }
}

/**
 * Read the saved settings and build the pipeline.
 *
 * Never throws: a settings read that fails (a migrated-but-empty table, a
 * rotated encryption key) falls back to rules only, because classification
 * failing is worse than classification being basic.
 */
export async function loadDecisionPipeline(
  userId: string,
): Promise<DecisionPipeline> {
  try {
    return pipelineFromConfig(await getAiPipelineConfig(userId))
  } catch (error) {
    console.error('[ai] could not load AI settings; using rules only:', error)
    return defaultDecisionPipeline()
  }
}

/** The reply drafter for one user, and the threshold it is gated on. */
export type ReplyDrafting = {
  /**
   * Null when no LLM key is stored. Not an error: a user without one simply has
   * no drafts, and the conversation view says so rather than offering a button
   * that would fail.
   */
  drafter: ReplyDrafter | null
  /** 1–10, from the same row. */
  minImportance: number
}

/**
 * Build the reply drafter from the saved settings.
 *
 * Never throws, for the same reason `loadDecisionPipeline` does not: a settings
 * read that fails must cost drafts, not break the conversation someone is
 * looking at. One read of the row serves both the key and the threshold, so the
 * view's explanation of why it offered nothing always matches the gate the
 * server would apply.
 */
export async function loadReplyDrafter(userId: string): Promise<ReplyDrafting> {
  try {
    const config = await getAiPipelineConfig(userId)
    return {
      drafter: replyDrafterFromConfig(config.llm),
      minImportance: config.suggestReplyMinImportance,
    }
  } catch (error) {
    console.error('[ai] could not load the reply drafter:', error)
    return {
      drafter: null,
      minImportance: REPLY_DRAFT_MIN_IMPORTANCE_DEFAULT,
    }
  }
}
