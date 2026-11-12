import { describe, expect, test } from 'bun:test'

import {
  buildGoalInferencePrompt,
  MAX_INFERRED_GOAL_LENGTH,
  parseInferredGoal,
} from './goal.ts'

describe('buildGoalInferencePrompt', () => {
  test('asks for an outcome from the user’s own reply', () => {
    const prompt = buildGoalInferencePrompt({
      topic: 'Launch date',
      incoming: 'Can we move the launch to Tuesday?',
      sentReply: 'Tuesday works for me.',
    })

    expect(prompt).toContain(
      'Infer what I want out of this conversation from the reply I sent.',
    )
    expect(prompt).toContain('Thread topic: Launch date')
    expect(prompt).toContain('The message I was answering:')
    expect(prompt).toContain('Can we move the launch to Tuesday?')
    expect(prompt).toContain('The reply I sent:')
    expect(prompt).toContain('Tuesday works for me.')
  })

  test('works without a topic or an incoming message', () => {
    const prompt = buildGoalInferencePrompt({
      topic: null,
      incoming: null,
      sentReply: 'Happy to help with the launch.',
    })

    expect(prompt).not.toContain('Thread topic:')
    expect(prompt).not.toContain('The message I was answering:')
    expect(prompt).toContain('Happy to help with the launch.')
  })
})

describe('parseInferredGoal', () => {
  test('keeps one clean sentence from a fenced, quoted answer', () => {
    expect(parseInferredGoal('```\n"Confirm the Tuesday launch."\n```')).toBe(
      'Confirm the Tuesday launch.',
    )
  })

  test('drops a label the model added', () => {
    expect(parseInferredGoal('Goal: Get a decision on the launch date.')).toBe(
      'Get a decision on the launch date.',
    )
  })

  test('keeps only the first non-empty line and collapses spacing', () => {
    expect(
      parseInferredGoal('\n\nConfirm   the launch.\nBecause it is due soon.'),
    ).toBe('Confirm the launch.')
  })

  test('rejects an empty answer', () => {
    expect(parseInferredGoal('')).toBeNull()
    expect(parseInferredGoal('   \n  ')).toBeNull()
  })

  test('caps a runaway goal', () => {
    const goal = parseInferredGoal('x'.repeat(600))
    expect(goal).toHaveLength(MAX_INFERRED_GOAL_LENGTH)
  })
})
