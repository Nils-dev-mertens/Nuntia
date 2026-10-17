import { describe, expect, test } from 'bun:test'

import {
  HeuristicRuleClassifier,
  NoTopicGenerator,
  PlaceholderDecisionModel,
} from '#/lib/conversation/index.ts'

import { pipelineFromConfig } from './index.ts'
import { JevDecisionModel } from './jev.ts'
import { LlmTopicGenerator } from './llm.ts'

describe('pipelineFromConfig', () => {
  test('with nothing configured the pipeline is rules-only', () => {
    const pipeline = pipelineFromConfig({
      jev: null,
      llm: null,
      suggestReplyMinImportance: 6,
    })

    expect(pipeline.rules).toBeInstanceOf(HeuristicRuleClassifier)
    expect(pipeline.model).toBeInstanceOf(PlaceholderDecisionModel)
    expect(pipeline.topics).toBeInstanceOf(NoTopicGenerator)
  })

  test('swaps in Jev and the LLM independently', () => {
    const jevOnly = pipelineFromConfig({
      jev: { apiKey: 'k', model: 'jev-latest' },
      llm: null,
      suggestReplyMinImportance: 6,
    })
    expect(jevOnly.model).toBeInstanceOf(JevDecisionModel)
    expect(jevOnly.topics).toBeInstanceOf(NoTopicGenerator)

    const llmOnly = pipelineFromConfig({
      jev: null,
      llm: { provider: 'openai', apiKey: 'k', model: 'm' },
      suggestReplyMinImportance: 6,
    })
    expect(llmOnly.model).toBeInstanceOf(PlaceholderDecisionModel)
    expect(llmOnly.topics).toBeInstanceOf(LlmTopicGenerator)

    const both = pipelineFromConfig({
      jev: { apiKey: 'k', model: 'jev-latest' },
      llm: { provider: 'gemini', apiKey: 'k', model: 'm' },
      suggestReplyMinImportance: 6,
    })
    expect(both.model).toBeInstanceOf(JevDecisionModel)
    expect(both.topics).toBeInstanceOf(LlmTopicGenerator)
  })
})
