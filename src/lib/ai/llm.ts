/**
 * The LLM side: prose, not decisions.
 *
 * This is the `TopicGenerator` seam — the topic label — plus `completeLlm`, the
 * shared transport the reply drafter in `draft.ts` also uses. It is deliberately
 * *not* the decision layer: Jev makes decisions, an LLM writes text. See
 * `decision.ts`.
 *
 * Three providers are supported behind one interface (Anthropic, OpenAI, Gemini),
 * each with a bring-your-own key. Adding a fourth means one more `complete`
 * function and one more case in the factory — nothing upstream changes.
 *
 * Every provider call carries a `log` label, so a failure names the service and
 * the model in the AI log rather than only appearing in a terminal.
 */

import type { DecisionInput, TopicGenerator } from '#/lib/conversation/index.ts'

import { asRecord, isRecord, postJson } from './http.ts'
import type { FetchLike } from './http.ts'

export type LlmProvider = 'anthropic' | 'openai' | 'gemini'

export const LLM_PROVIDERS: readonly LlmProvider[] = [
  'anthropic',
  'openai',
  'gemini',
]

/** Sensible per-provider defaults; `LLM_MODEL` overrides them. */
export const DEFAULT_LLM_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4.1-mini',
  gemini: 'gemini-2.5-flash',
}

export type LlmConfig = {
  provider: LlmProvider
  apiKey: string
  model: string
  fetchImpl?: FetchLike
}

/** A topic is a label, not a sentence; cap it so a chatty model cannot flood the row. */
const MAX_TOPIC_LENGTH = 80

/** Completion budget for a label: a handful of tokens is plenty. */
const MAX_TOPIC_TOKENS = 64

/**
 * Completion budget for a reasoning model (o-series, gpt-5).
 *
 * Those models spend `max_completion_tokens` on hidden reasoning *before*
 * writing anything, so a label-sized budget is swallowed entirely by thinking
 * and the call fails with "max_tokens or model output limit was reached". The
 * budget has to cover the reasoning, not just the label.
 */
const MAX_REASONING_TOPIC_TOKENS = 4_096

/** How much of the thread the model sees. Enough to label, not enough to be slow. */
const MAX_MESSAGES = 6
const MAX_MESSAGE_CHARS = 1_200

export class LlmTopicGenerator implements TopicGenerator {
  readonly name: string
  private readonly config: LlmConfig

  constructor(config: LlmConfig) {
    this.config = config
    this.name = `llm:${config.provider}`
  }

  async generate(input: DecisionInput): Promise<string | null> {
    const text = await completeLlm(
      this.config,
      topicPrompt(input),
      // A label is a handful of tokens — except on a reasoning model, where the
      // budget also has to pay for the hidden thinking that precedes it.
      isReasoningModel(this.config.model)
        ? MAX_REASONING_TOPIC_TOKENS
        : MAX_TOPIC_TOKENS,
    )
    return sanitizeTopic(text)
  }
}

/**
 * One prompt in, one completion out, for whichever provider is configured.
 *
 * Shared with `draft.ts`, because the providers differ only in transport and a
 * second caller should not mean a second copy of three request shapes. The budget
 * stays with the caller: a short label and a reply want very different ones, and
 * on OpenAI it has to cover hidden reasoning as well as output.
 */
export async function completeLlm(
  config: LlmConfig,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  switch (config.provider) {
    case 'anthropic':
      return anthropicComplete(config, prompt, maxTokens)
    case 'openai':
      return openaiComplete(config, prompt, maxTokens)
    case 'gemini':
      // Deliberately no output cap on this one — see `geminiComplete`.
      return geminiComplete(config, prompt)
  }
}

/** One prompt for all providers: a short label, nothing else. */
function topicPrompt(input: DecisionInput): string {
  const lines: string[] = []
  if (input.goal) lines.push(`What the user wants: ${input.goal}`)

  for (const message of input.messages.slice(-MAX_MESSAGES)) {
    const who = message.isFromOwner
      ? 'Me'
      : (message.from.name ?? message.from.email)
    lines.push(`${who}: ${message.body.slice(0, MAX_MESSAGE_CHARS)}`)
  }

  return [
    'Write a short topic label (2 to 6 words) for this email thread.',
    'Reply with the label only — no quotes, no trailing punctuation, no explanation.',
    '',
    `Subject: ${input.subject}`,
    '',
    lines.join('\n'),
  ].join('\n')
}

async function anthropicComplete(
  config: LlmConfig,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const json = asRecord(
    await postJson({
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: config.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      },
      fetchImpl: config.fetchImpl,
      log: { service: `llm:${config.provider}`, model: config.model },
    }),
    'Anthropic response',
  )

  if (Array.isArray(json.content)) {
    for (const part of json.content) {
      if (
        isRecord(part) &&
        part.type === 'text' &&
        typeof part.text === 'string'
      ) {
        return part.text
      }
    }
  }
  return ''
}

async function openaiComplete(
  config: LlmConfig,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const json = asRecord(
    await postJson({
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: {
        model: config.model,
        // OpenAI names this `max_completion_tokens`; the older `max_tokens` is
        // rejected outright by the reasoning models (o-series, gpt-5).
        max_completion_tokens: maxTokens,
        // Those same models accept only the default temperature, so the
        // low-temperature hint is sent only where it is valid.
        ...(isReasoningModel(config.model) ? {} : { temperature: 0.2 }),
        messages: [{ role: 'user', content: prompt }],
      },
      fetchImpl: config.fetchImpl,
      log: { service: `llm:${config.provider}`, model: config.model },
    }),
    'OpenAI response',
  )

  const first = Array.isArray(json.choices) ? json.choices[0] : undefined
  if (isRecord(first) && isRecord(first.message)) {
    const content = first.message.content
    if (typeof content === 'string') return content
  }
  return ''
}

/**
 * Whether an OpenAI chat model is a reasoning model (o-series or gpt-5).
 *
 * Two differences matter here: they reject sampling parameters such as
 * `temperature`, and they spend `max_completion_tokens` on hidden reasoning
 * before producing any output. Both callers (the topic generator and the reply
 * drafter) have to size their budget accordingly rather than for the text alone.
 */
export function isReasoningModel(model: string): boolean {
  const id = model.toLowerCase()
  return /^o\d/.test(id) || id.startsWith('gpt-5')
}

/**
 * Gemini, with no output cap on purpose.
 *
 * Gemini 2.5 counts *thinking* tokens against `maxOutputTokens`, so capping it
 * the way the other two providers are capped would spend a label's budget on
 * hidden reasoning and return no text at all. The prompt asks for something
 * short and `sanitizeTopic` enforces it, which is the cheaper guard here.
 */
async function geminiComplete(
  config: LlmConfig,
  prompt: string,
): Promise<string> {
  const json = asRecord(
    await postJson({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        config.model,
      )}:generateContent`,
      headers: { 'x-goog-api-key': config.apiKey },
      body: { contents: [{ parts: [{ text: prompt }] }] },
      fetchImpl: config.fetchImpl,
      log: { service: `llm:${config.provider}`, model: config.model },
    }),
    'Gemini response',
  )

  const candidate = Array.isArray(json.candidates)
    ? json.candidates[0]
    : undefined
  if (isRecord(candidate) && isRecord(candidate.content)) {
    const parts = candidate.content.parts
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (isRecord(part) && typeof part.text === 'string') return part.text
      }
    }
  }
  return ''
}

/**
 * Turn whatever the model wrote into a bare label.
 *
 * Models like to wrap a short answer in quotes, a markdown fence, or a trailing
 * period, and occasionally add a sentence after it. All of that is stripped here
 * so the value that reaches the row is what a topic should look like — and an
 * empty result becomes `null` rather than an empty string.
 */
export function sanitizeTopic(raw: string): string | null {
  let text = raw.trim()

  // A fenced block, optionally with a language tag.
  text = text
    .replace(/^```[^\n]*\n?/, '')
    .replace(/```\s*$/, '')
    .trim()
  // Take the first non-empty line: a label is one line.
  text = text.split('\n').find((line) => line.trim()) ?? ''
  text = text.trim()
  // Surrounding quotes of any common style.
  text = text
    .replace(/^["'“”‘’]+/, '')
    .replace(/["'“”‘’]+$/, '')
    .trim()
  // Trailing sentence punctuation, then collapse internal whitespace.
  text = text.replace(/[.!?,;:]+$/, '').trim()
  text = text.replace(/\s+/g, ' ')

  if (!text) return null
  return text.length > MAX_TOPIC_LENGTH
    ? `${text.slice(0, MAX_TOPIC_LENGTH - 1)}…`
    : text
}
