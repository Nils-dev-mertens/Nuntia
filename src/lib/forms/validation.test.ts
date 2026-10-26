/**
 * The form rules.
 *
 * No database and no request: this module is what both the builder and the
 * answer route rely on, so the interesting cases are the ones that must be
 * refused — an option that no longer exists, a scale value outside 1–5, a
 * required question left blank — plus the normalisation the repository writes.
 */

import { describe, expect, test } from 'bun:test'

import { FORM_LIMITS, validateFormAnswers, validateFormDraft } from './validation.ts'
import type { AnswerableQuestion } from './validation.ts'

const draft = {
  title: '  What should we build?  ',
  description: 'A few questions about saved replies.',
  questions: [
    { type: 'short-text' as const, prompt: ' What is missing? ', required: true },
    {
      type: 'choice' as const,
      prompt: 'Where would it live?',
      options: [' Composer ', 'Inbox'],
    },
  ],
}

describe('validateFormDraft', () => {
  test('trims strings and defaults the audience to everyone', () => {
    const result = validateFormDraft(draft)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.title).toBe('What should we build?')
    expect(result.value.audience).toBe('all')
    expect(result.value.audienceUserIds).toEqual([])
    expect(result.value.questions[0].prompt).toBe('What is missing?')
    expect(result.value.questions[1].options).toEqual(['Composer', 'Inbox'])
  })

  test('refuses an empty title, no questions or no prompt', () => {
    expect(validateFormDraft({ ...draft, title: '  ' }).ok).toBe(false)
    expect(validateFormDraft({ ...draft, questions: [] }).ok).toBe(false)
    expect(
      validateFormDraft({ ...draft, questions: [{ type: 'short-text', prompt: ' ' }] })
        .ok,
    ).toBe(false)
  })

  test('choice questions need two distinct, bounded options', () => {
    const choice = (options: string[]) =>
      validateFormDraft({
        ...draft,
        questions: [{ type: 'choice', prompt: 'Pick', options }],
      })

    expect(choice(['Only one']).ok).toBe(false)
    expect(choice(['Same', 'same']).ok).toBe(false)
    expect(choice(['a'.repeat(FORM_LIMITS.option + 1), 'Other']).ok).toBe(false)
    expect(choice(Array.from({ length: 11 }, (_, index) => `Option ${index}`)).ok).toBe(
      false,
    )
    expect(choice(['One', 'Two']).ok).toBe(true)
  })

  test('a selected audience needs at least one person, deduplicated', () => {
    expect(
      validateFormDraft({ ...draft, audience: 'selected', audienceUserIds: [] }).ok,
    ).toBe(false)

    const result = validateFormDraft({
      ...draft,
      audience: 'selected',
      audienceUserIds: ['Ada@Example.com', 'ada@example.com', 'bob@example.com'],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.audienceUserIds).toEqual([
        'ada@example.com',
        'bob@example.com',
      ])
    }
  })

  test('scale labels are kept for scales and dropped elsewhere', () => {
    const result = validateFormDraft({
      ...draft,
      questions: [
        {
          type: 'scale',
          prompt: 'How useful?',
          scaleLowLabel: ' Not useful ',
          scaleHighLabel: 'Daily',
        },
        { type: 'yes-no', prompt: 'Again?', scaleLowLabel: 'ignored' },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questions[0].scaleLowLabel).toBe('Not useful')
    expect(result.value.questions[1].scaleLowLabel).toBeNull()
  })

  test('refuses an unknown question type', () => {
    const result = validateFormDraft({
      ...draft,
      questions: [{ type: 'ranking', prompt: 'Rank these' }],
    })
    expect(result.ok).toBe(false)
  })
})

const questions: AnswerableQuestion[] = [
  {
    id: 'q-text',
    type: 'short-text',
    prompt: 'What is missing?',
    required: true,
    options: [],
  },
  {
    id: 'q-choice',
    type: 'choice',
    prompt: 'Where?',
    required: false,
    options: ['Composer', 'Inbox'],
  },
  {
    id: 'q-multi',
    type: 'multi-choice',
    prompt: 'Which parts?',
    required: false,
    options: ['Drafts', 'Topics', 'Search'],
  },
  {
    id: 'q-scale',
    type: 'scale',
    prompt: 'How useful?',
    required: false,
    options: [],
  },
  {
    id: 'q-yes',
    type: 'yes-no',
    prompt: 'Follow up?',
    required: false,
    options: [],
  },
]

describe('validateFormAnswers', () => {
  test('requires the required question and drops empty optional ones', () => {
    const missing = validateFormAnswers(questions, [])
    expect(missing.ok).toBe(false)

    const answered = validateFormAnswers(questions, [
      { questionId: 'q-text', text: ' Saved replies ' },
      { questionId: 'q-choice', text: '' },
      { questionId: 'q-multi', choices: [] },
    ])

    expect(answered.ok).toBe(true)
    if (!answered.ok) return
    expect(answered.value).toEqual([
      { questionId: 'q-text', text: 'Saved replies', number: null, choices: null },
    ])
  })

  test('rejects answers to questions the form does not have, or duplicates', () => {
    expect(
      validateFormAnswers(questions, [
        { questionId: 'q-text', text: 'Yes' },
        { questionId: 'gone', text: 'Stale' },
      ]).ok,
    ).toBe(false)

    expect(
      validateFormAnswers(questions, [
        { questionId: 'q-text', text: 'Yes' },
        { questionId: 'q-text', text: 'Again' },
      ]).ok,
    ).toBe(false)
  })

  test('choice and multi-choice values must come from the options', () => {
    expect(
      validateFormAnswers(questions, [
        { questionId: 'q-text', text: 'Search' },
        { questionId: 'q-choice', text: 'Sidebar' },
      ]).ok,
    ).toBe(false)

    expect(
      validateFormAnswers(questions, [
        { questionId: 'q-text', text: 'Search' },
        { questionId: 'q-multi', choices: ['Drafts', 'Nonsense'] },
      ]).ok,
    ).toBe(false)
  })

  test('multi-choice answers are stored in the question’s option order', () => {
    const result = validateFormAnswers(questions, [
      { questionId: 'q-text', text: 'Search' },
      { questionId: 'q-multi', choices: ['Search', 'Drafts'] },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toContainEqual({
      questionId: 'q-multi',
      text: null,
      number: null,
      choices: ['Drafts', 'Search'],
    })
  })

  test('scales are integers from 1 to 5, and yes/no is literal', () => {
    expect(
      validateFormAnswers(questions, [
        { questionId: 'q-text', text: 'Search' },
        { questionId: 'q-scale', number: 6 },
      ]).ok,
    ).toBe(false)

    expect(
      validateFormAnswers(questions, [
        { questionId: 'q-text', text: 'Search' },
        { questionId: 'q-scale', number: 4 },
        { questionId: 'q-yes', text: 'maybe' },
      ]).ok,
    ).toBe(false)

    const result = validateFormAnswers(questions, [
      { questionId: 'q-text', text: 'Search' },
      { questionId: 'q-scale', number: 4 },
      { questionId: 'q-yes', text: 'Yes' },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toContainEqual({
      questionId: 'q-yes',
      text: 'yes',
      number: null,
      choices: null,
    })
  })

  test('text answers are capped by the question type', () => {
    const result = validateFormAnswers(questions, [
      { questionId: 'q-text', text: 'a'.repeat(FORM_LIMITS.shortText + 1) },
    ])
    expect(result.ok).toBe(false)
  })
})
