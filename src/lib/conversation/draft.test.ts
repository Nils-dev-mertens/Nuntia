import { describe, expect, test } from 'bun:test'

import {
  buildReplyDraftPrompt,
  replyDraftEligibility,
  sanitizeDraft,
} from './draft.ts'
import type { ReplyDraftRequest } from './draft.ts'

/**
 * The gate.
 *
 * What is left once "the message asks for something" stopped being a condition,
 * and the order the reasons are reported in — because only one is shown, and "no
 * LLM key" is the wrong thing to tell someone whose thread is simply unreachable.
 */
describe('replyDraftEligibility', () => {
  const ok = {
    modelConfigured: true,
    replyable: true,
    awaitingReply: false,
    importance: 8,
    minImportance: 6,
  }

  test('passes when a reply is asked for, is reachable, and matters enough', () => {
    const result = replyDraftEligibility(ok)
    expect(result.eligible).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.detail).toBeNull()
  })

  test('importance at the threshold is enough; one below is not', () => {
    expect(replyDraftEligibility({ ...ok, importance: 6 }).eligible).toBe(true)

    const low = replyDraftEligibility({ ...ok, importance: 5 })
    expect(low.eligible).toBe(false)
    if (low.eligible) return
    expect(low.reason).toBe('not-important-enough')
    // The explanation names both numbers, so the threshold is adjustable by the
    // person reading it rather than a mystery.
    expect(low.detail).toContain('5/10')
    expect(low.detail).toContain('6')
  })

  test('an unconfigured install is told about the key, not about the thread', () => {
    const result = replyDraftEligibility({
      ...ok,
      modelConfigured: false,
      // Every thread-level condition failing at once: the key is still the answer.
      replyable: false,
      awaitingReply: true,
      importance: 1,
    })

    expect(result.eligible).toBe(false)
    if (result.eligible) return
    expect(result.reason).toBe('no-model')
  })

  test('a sender a reply cannot reach has nobody to draft for', () => {
    const result = replyDraftEligibility({ ...ok, replyable: false })
    expect(result.eligible).toBe(false)
    if (result.eligible) return
    expect(result.reason).toBe('unreplyable')
  })

  test('a thread the user spoke last in has nothing to answer', () => {
    const result = replyDraftEligibility({ ...ok, awaitingReply: true })
    expect(result.eligible).toBe(false)
    if (result.eligible) return
    expect(result.reason).toBe('already-answered')
  })

  test('a thread that asks for nothing still qualifies', () => {
    // The goal is the reason to write, not a request in the newest message: a
    // reply that only nudges the conversation forward is what a goal often
    // needs, and it used to be refused for exactly that reason.
    const result = replyDraftEligibility({ ...ok, importance: 10 })
    expect(result.eligible).toBe(true)
    expect(result.reason).toBeNull()
  })
})

describe('buildReplyDraftPrompt', () => {
  function request(
    overrides: Partial<ReplyDraftRequest> = {},
  ): ReplyDraftRequest {
    return {
      subject: 'Launch date',
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
        {
          speaker: 'Me',
          isFromOwner: true,
          sentAt: '2024-01-15T11:00:00.000Z',
          body: 'Wednesday would work for me.',
        },
      ],
      greeting: null,
      signature: null,
      instructions: null,
      ...overrides,
    }
  }

  test('carries the topic, the goal, the recipient and the thread in order', () => {
    const prompt = buildReplyDraftPrompt(request())

    expect(prompt).toContain(
      'What I want out of this conversation: Confirm whether Tuesday works',
    )
    expect(prompt).toContain('What it is about: Finalizing the launch date')
    expect(prompt).toContain('Replying to: Sarah <sarah@example.com>')
    expect(prompt).toContain('Subject: Launch date')

    const first = prompt.indexOf('Sarah: Can we move the launch to Tuesday?')
    const second = prompt.indexOf('Me: Wednesday would work for me.')
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
  })

  test('tells the model what the send path adds, and only what it adds', () => {
    const withStyle = buildReplyDraftPrompt(
      request({ greeting: 'Hi Sarah,', signature: 'Best regards,\nNils' }),
    )
    expect(withStyle).toContain(
      'Do not write a greeting — "Hi Sarah," is added automatically.',
    )
    expect(withStyle).toContain('Do not write a sign-off or signature')

    // With neither, the model is still told not to write one — but not promised
    // that one is being added, which is what would make it skip the opener.
    const bare = buildReplyDraftPrompt(request())
    expect(bare).toContain('Do not write a greeting or a sign-off.')
    expect(bare).not.toContain('is added automatically')
  })

  test('passes the user instruction through', () => {
    const prompt = buildReplyDraftPrompt(
      request({
        instructions: 'Keep it to one line and propose Thursday instead.',
      }),
    )
    expect(prompt).toContain(
      'Keep it to one line and propose Thursday instead.',
    )
  })

  test('drops the older history rather than growing without bound', () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      speaker: index % 2 === 0 ? 'Sarah' : 'Me',
      isFromOwner: index % 2 === 1,
      sentAt: `2024-01-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
      body: `Message number ${index}`,
    }))

    const prompt = buildReplyDraftPrompt(request({ messages }))

    // The newest messages are the ones a reply has to answer, so they are the
    // ones kept.
    expect(prompt).toContain('Message number 11')
    expect(prompt).not.toContain('Message number 3')
  })
})

describe('sanitizeDraft', () => {
  const keep = { stripGreeting: false, stripSignature: false }

  test('unwraps a fenced block and drops a "Draft:" label', () => {
    expect(sanitizeDraft('```\nTuesday works for me.\n```', keep)).toBe(
      'Tuesday works for me.',
    )
    expect(sanitizeDraft('Draft: Tuesday works for me.', keep)).toBe(
      'Tuesday works for me.',
    )
  })

  test('removes one matched pair of quotes, but not a quote inside the text', () => {
    expect(sanitizeDraft('"Tuesday works for me."', keep)).toBe(
      'Tuesday works for me.',
    )
    // An internal quote means the outer characters are content, not a wrapper.
    expect(sanitizeDraft('He said "no" about Tuesday.', keep)).toBe(
      'He said "no" about Tuesday.',
    )
  })

  test('drops a greeting and signature only when the send path will replace them', () => {
    const written = 'Hi Sarah,\n\nTuesday works for me.\n\nBest regards,\nNils'

    // Nothing is added on send, so both stay: a reply with no salutation at all
    // is the worse failure.
    expect(sanitizeDraft(written, keep)).toBe(written)

    // The send path adds its own, so the model's copies are the second of each.
    expect(
      sanitizeDraft(written, { stripGreeting: true, stripSignature: true }),
    ).toBe('Tuesday works for me.')
  })

  test('collapses a blank-line pile-up and returns null for nothing usable', () => {
    expect(sanitizeDraft('Tuesday works.\n\n\n\nThat is all.', keep)).toBe(
      'Tuesday works.\n\nThat is all.',
    )
    expect(sanitizeDraft('   ', keep)).toBeNull()
    expect(sanitizeDraft('```\n```', keep)).toBeNull()
    // A greeting the model wrote, when it is the whole answer, is kept: the mail
    // parser refuses to empty a body for the same reason.
    expect(sanitizeDraft('Hi Sarah,', { ...keep, stripGreeting: true })).toBe(
      'Hi Sarah,',
    )
  })

  test('caps a runaway draft instead of handing back nothing', () => {
    const long = 'a'.repeat(10_000)
    const result = sanitizeDraft(long, keep)

    expect(result?.length).toBe(4_000)
  })
})
