/**
 * AI services, composed from the saved settings.
 *
 * Both services are **optional and independently configured in the UI**:
 *
 *   Jev          → the decision model (importance, urgency, a state to fill)
 *   LLM provider → the topic generator (prose)
 *
 * `pipelineFromConfig` is the pure part and is what tests exercise.
 * `loadDecisionPipeline` reads the settings row from the database; when nothing
 * is configured — or the settings cannot be read — it returns the all-rules
 * pipeline, so the app behaves exactly as it did before any key was set. That is
 * the "degrades per service" contract, not an error state.
 */

import {
  defaultDecisionPipeline,
  NoTopicGenerator,
  PlaceholderDecisionModel,
} from '#/lib/conversation/index.ts'
import type { DecisionPipeline } from '#/lib/conversation/index.ts'

import { JevDecisionModel } from './jev.ts'
import { LlmTopicGenerator } from './llm.ts'
import { getAiPipelineConfig } from './settings.ts'
import type { AiPipelineConfig } from './settings.ts'

export { JevDecisionModel } from './jev.ts'
export type { JevConfig } from './jev.ts'
export {
  DEFAULT_LLM_MODELS,
  LLM_PROVIDERS,
  LlmTopicGenerator,
  sanitizeTopic,
} from './llm.ts'
export type { LlmConfig, LlmProvider } from './llm.ts'
export { AiRequestError, postJson } from './http.ts'
export type { FetchLike, JsonRetryPolicy } from './http.ts'
export {
  getAiPipelineConfig,
  getAiSettings,
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
export async function loadDecisionPipeline(): Promise<DecisionPipeline> {
  try {
    return pipelineFromConfig(await getAiPipelineConfig())
  } catch (error) {
    console.error('[ai] could not load AI settings; using rules only:', error)
    return defaultDecisionPipeline()
  }
}
