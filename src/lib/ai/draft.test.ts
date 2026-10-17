import { describe, expect, test } from 'bun:test'

import type { ReplyDraftRequest } from '#/lib/conversation/index.ts'

import { LlmReplyDrafter, replyDrafterFromConfig } from './draft.ts'
import type { FetchLike } from './http.ts'

/**
 * A thread that asks for an answer, with the send path about to add a greeting
 * and a signature — the two facts the prompt and the sanitiser both depend on.
 */
const REQUEST: ReplyDraftRequest = {
  subject: 'Re: Project launch',
  topic: 'Finalizing the launch date',
  goal: 'Confirm whether Tuesday works',
  recipient: { name: 'Sarah', email: 'sarah@example.com' },
  ownerEmail: 'me@example.com',
  messages: [
    {
      speaker: 'Sarah',
      isFromOwner: false,
      sentAt: '2024-01-15T10:00:00.000Z',
      body: 'Can we move the launch to Tuesday?',
    },
  ],
  greeting: 'Hi Sarah,',
  signature: 'Best regards,\nMe',
  instructions: null,
}

function json(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) }
}

describe('LlmReplyDrafter', () => {
  test('asks Anthropic for a body and drops the greeting it wrote anyway', async () => {
    let sent: Record<string, unknown> = {}
    const fetchImpl: FetchLike = async (url, init) => {
      expect(url).toContain('api.anthropic.com')
      expect(init.headers['x-api-key']).toBe('k')
      sent = JSON.parse(init.body) as Record<string, unknown>

      return json(200, {
        content: [
          {
            type: 'text',
            text: 'Hi Sarah,\n\nTuesday works for me.\n\nBest regards,\nMe',
          },
        ],
      })
    }

    const drafter = new LlmReplyDrafter({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'm',
      fetchImpl,
    })

    expect(await drafter.draft(REQUEST)).toBe('Tuesday works for me.')
    expect(drafter.name).toBe('llm:anthropic')

    // The prompt is the whole conversation state, not just the last message.
    const prompt = String(sent.messages && JSON.stringify(sent.messages))
    expect(prompt).toContain('Confirm whether Tuesday works')
    expect(prompt).toContain('Can we move the launch to Tuesday?')
    // A draft gets a reply-sized budget, not a label-sized one.
    expect(sent.max_tokens).toBe(1_024)
  })

  test('gives an OpenAI reasoning model room for the body as well as the thinking', async () => {
    let sent: Record<string, unknown> = {}
    const fetchImpl: FetchLike = async (_url, init) => {
      sent = JSON.parse(init.body) as Record<string, unknown>
      return json(200, {
        choices: [{ message: { content: 'Tuesday works.' } }],
      })
    }

    const drafter = new LlmReplyDrafter({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5-mini',
      fetchImpl,
    })

    expect(await drafter.draft(REQUEST)).toBe('Tuesday works.')
    expect(sent.max_completion_tokens).toBe(8_192)
    // Reasoning models accept only the default temperature.
    expect(sent.temperature).toBeUndefined()
  })

  test('uses a plain budget and a low temperature on an ordinary OpenAI model', async () => {
    let sent: Record<string, unknown> = {}
    const fetchImpl: FetchLike = async (_url, init) => {
      sent = JSON.parse(init.body) as Record<string, unknown>
      return json(200, {
        choices: [{ message: { content: 'Tuesday works.' } }],
      })
    }

    const drafter = new LlmReplyDrafter({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4.1-mini',
      fetchImpl,
    })

    expect(await drafter.draft(REQUEST)).toBe('Tuesday works.')
    expect(sent.max_completion_tokens).toBe(1_024)
    expect(sent.temperature).toBe(0.2)
  })

  test('reads a Gemini response', async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      expect(url).toContain('generativelanguage.googleapis.com')
      expect(init.headers['x-goog-api-key']).toBe('k')
      return json(200, {
        candidates: [
          { content: { parts: [{ text: '```\nTuesday works.\n```' }] } },
        ],
      })
    }

    const drafter = new LlmReplyDrafter({
      provider: 'gemini',
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      fetchImpl,
    })

    expect(await drafter.draft(REQUEST)).toBe('Tuesday works.')
  })

  test('keeps the greeting and signature when the send path adds neither', async () => {
    const fetchImpl: FetchLike = async () =>
      json(200, {
        content: [{ type: 'text', text: 'Hi Sarah,\n\nTuesday works.' }],
      })

    const drafter = new LlmReplyDrafter({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'm',
      fetchImpl,
    })

    const draft = await drafter.draft({
      ...REQUEST,
      greeting: null,
      signature: null,
    })

    expect(draft).toBe('Hi Sarah,\n\nTuesday works.')
  })

  test('returns null when the model produces nothing usable', async () => {
    const fetchImpl: FetchLike = async () => json(200, { content: [] })

    const drafter = new LlmReplyDrafter({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'm',
      fetchImpl,
    })

    expect(await drafter.draft(REQUEST)).toBeNull()
  })
})

describe('replyDrafterFromConfig', () => {
  test('is null without a key, so nothing can call a provider', () => {
    expect(replyDrafterFromConfig(null)).toBeNull()
    expect(replyDrafterFromConfig(undefined)).toBeNull()
  })

  test('builds the drafter for the configured provider', () => {
    const drafter = replyDrafterFromConfig({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4.1-mini',
    })

    expect(drafter).toBeInstanceOf(LlmReplyDrafter)
    expect(drafter?.name).toBe('llm:openai')
  })
})
