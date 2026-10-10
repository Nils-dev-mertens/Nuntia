import { describe, expect, test } from 'bun:test'

import type { DecisionInput } from '#/lib/conversation/index.ts'

import { LlmTopicGenerator, sanitizeTopic } from './llm.ts'
import type { FetchLike } from './http.ts'

const INPUT: DecisionInput = {
  subject: 'Re: Project launch',
  messages: [],
  ownerEmail: 'me@example.com',
  goal: null,
  decidedAt: null,
}

function json(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) }
}

describe('LlmTopicGenerator', () => {
  test('reads an Anthropic response and sanitizes the label', async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      expect(url).toContain('api.anthropic.com')
      expect(init.headers['x-api-key']).toBe('k')
      return json(200, { content: [{ type: 'text', text: '"Launch schedule."' }] })
    }

    const generator = new LlmTopicGenerator({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'm',
      fetchImpl,
    })

    expect(await generator.generate(INPUT)).toBe('Launch schedule')
    expect(generator.name).toBe('llm:anthropic')
  })

  test('reads an OpenAI response and sends a parameter set current models accept', async () => {
    let body: Record<string, unknown> = {}
    const fetchImpl: FetchLike = async (url, init) => {
      expect(url).toContain('api.openai.com')
      body = JSON.parse(init.body) as Record<string, unknown>
      return json(200, { choices: [{ message: { content: 'Launch schedule' } }] })
    }

    const generator = new LlmTopicGenerator({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4.1-mini',
      fetchImpl,
    })

    expect(await generator.generate(INPUT)).toBe('Launch schedule')
    // `max_tokens` is rejected by the reasoning models; the current name is
    // `max_completion_tokens`.
    expect(body.max_completion_tokens).toBe(64)
    expect(body.max_tokens).toBeUndefined()
    expect(body.temperature).toBe(0.2)
  })

  test('gives a reasoning model room to think and omits temperature', async () => {
    let body: Record<string, unknown> = {}
    const fetchImpl: FetchLike = async (_url, init) => {
      body = JSON.parse(init.body) as Record<string, unknown>
      return json(200, { choices: [{ message: { content: 'Launch schedule' } }] })
    }

    const generator = new LlmTopicGenerator({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5-mini',
      fetchImpl,
    })

    expect(await generator.generate(INPUT)).toBe('Launch schedule')
    // `max_completion_tokens` also pays for hidden reasoning, so a label-sized
    // budget is spent before the model writes a word and the call 400s.
    expect(body.max_completion_tokens).toBe(4096)
    expect(body.temperature).toBeUndefined()
  })

  test('gives an o-series model the same reasoning budget', async () => {
    let body: Record<string, unknown> = {}
    const fetchImpl: FetchLike = async (_url, init) => {
      body = JSON.parse(init.body) as Record<string, unknown>
      return json(200, { choices: [{ message: { content: 'Launch schedule' } }] })
    }

    const generator = new LlmTopicGenerator({
      provider: 'openai',
      apiKey: 'k',
      model: 'o3',
      fetchImpl,
    })

    expect(await generator.generate(INPUT)).toBe('Launch schedule')
    expect(body.max_completion_tokens).toBe(4096)
    expect(body.temperature).toBeUndefined()
  })

  test('reads a Gemini response', async () => {
    const fetchImpl: FetchLike = async (url) => {
      expect(url).toContain('generativelanguage.googleapis.com')
      return json(200, {
        candidates: [{ content: { parts: [{ text: 'Launch schedule' }] } }],
      })
    }

    const generator = new LlmTopicGenerator({
      provider: 'gemini',
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      fetchImpl,
    })

    expect(await generator.generate(INPUT)).toBe('Launch schedule')
  })

  test('returns null when a provider answers with no text', async () => {
    const fetchImpl: FetchLike = async () => json(200, { content: [] })
    const generator = new LlmTopicGenerator({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'm',
      fetchImpl,
    })

    expect(await generator.generate(INPUT)).toBeNull()
  })
})

describe('sanitizeTopic', () => {
  test('strips quotes, fences and trailing punctuation', () => {
    expect(sanitizeTopic('"Launch schedule."')).toBe('Launch schedule')
    expect(sanitizeTopic('```\nLaunch schedule\n```')).toBe('Launch schedule')
    expect(sanitizeTopic('Launch schedule — Tuesday?')).toBe(
      'Launch schedule — Tuesday',
    )
  })

  test('keeps only the first line of a chatty answer', () => {
    expect(sanitizeTopic('Launch schedule\n\nLet me know if that works.')).toBe(
      'Launch schedule',
    )
  })

  test('collapses whitespace and returns null for nothing', () => {
    expect(sanitizeTopic('  Launch   schedule  ')).toBe('Launch schedule')
    expect(sanitizeTopic('   ')).toBeNull()
    expect(sanitizeTopic('""')).toBeNull()
  })

  test('caps a runaway label', () => {
    const long = 'a'.repeat(200)
    const result = sanitizeTopic(long)
    expect(result?.length).toBe(80)
    expect(result?.endsWith('…')).toBe(true)
  })
})
