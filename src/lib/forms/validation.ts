/**
 * Form definitions and answers, validated before anything touches the database.
 *
 * Pure and dependency-free: the admin builder, the answer route and their tests
 * all import this module, and none of them should drag the database in with it.
 * The rules are deliberately narrow — six question types, fixed 1–5 scales, no
 * branching — because a form builder that can express anything produces answers
 * that cannot be compared across weeks.
 */

import { FORM_QUESTION_TYPES } from '#/db/schema.ts'
import type { FormAudience, FormQuestionType } from '#/db/schema.ts'

export const FORM_LIMITS = {
  title: 140,
  description: 2_000,
  questions: 20,
  prompt: 280,
  help: 200,
  option: 80,
  options: 10,
  scaleLabel: 40,
  shortText: 80,
  longText: 2_000,
  audience: 500,
} as const

export const FORM_SCALE_VALUES = [1, 2, 3, 4, 5] as const

export type FormQuestionDraft = {
  type: FormQuestionType
  prompt: string
  help?: string | null
  required?: boolean
  options?: string[]
  scaleLowLabel?: string | null
  scaleHighLabel?: string | null
}

export type FormDraftInput = {
  title: string
  description?: string | null
  audience?: FormAudience
  audienceUserIds?: string[]
  questions: FormQuestionDraft[]
}

export type NormalisedFormQuestion = {
  type: FormQuestionType
  prompt: string
  help: string | null
  required: boolean
  options: string[]
  scaleLowLabel: string | null
  scaleHighLabel: string | null
}

export type NormalisedFormDraft = {
  title: string
  description: string
  audience: FormAudience
  audienceUserIds: string[]
  questions: NormalisedFormQuestion[]
}

/** A question as it is shown to a person filling the form in. */
export type FormQuestionView = NormalisedFormQuestion & {
  id: string
  key: string
  position: number
}

export type FormAnswerInput = {
  questionId: string
  text?: string | null
  number?: number | null
  choices?: string[] | null
}

export type AnswerableQuestion = Pick<
  FormQuestionView,
  'id' | 'type' | 'prompt' | 'required' | 'options'
>

export type NormalisedAnswer = {
  questionId: string
  text: string | null
  number: number | null
  choices: string[] | null
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

type Result<T> = ValidationResult<T>

function isQuestionType(value: unknown): value is FormQuestionType {
  return (
    typeof value === 'string' &&
    (FORM_QUESTION_TYPES as readonly string[]).includes(value)
  )
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function trimmedOrNull(value: unknown): string | null {
  const text = trimmed(value)
  return text ? text : null
}

function needsOptions(type: FormQuestionType): boolean {
  return type === 'choice' || type === 'multi-choice'
}

/**
 * Validate a whole draft, normalising every string.
 *
 * The return value is what the repository writes: the builder's local state is
 * allowed to contain empty option rows while the operator is typing, but a draft
 * that reaches storage has none of them.
 */
export function validateFormDraft(input: unknown): Result<NormalisedFormDraft> {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'That form could not be read.' }
  }

  const raw = input as Partial<FormDraftInput>

  const title = trimmed(raw.title)
  if (!title) return { ok: false, error: 'Give the form a title.' }
  if (title.length > FORM_LIMITS.title) {
    return {
      ok: false,
      error: `Keep the title under ${FORM_LIMITS.title} characters.`,
    }
  }

  const description = trimmed(raw.description)
  if (description.length > FORM_LIMITS.description) {
    return {
      ok: false,
      error: `Keep the description under ${FORM_LIMITS.description} characters.`,
    }
  }

  const audience: FormAudience = raw.audience === 'selected' ? 'selected' : 'all'
  const audienceUserIds = Array.isArray(raw.audienceUserIds)
    ? [
        ...new Set(
          raw.audienceUserIds
            .filter((id): id is string => typeof id === 'string')
            .map((id) => id.trim().toLowerCase())
            .filter(Boolean),
        ),
      ]
    : []

  if (audienceUserIds.length > FORM_LIMITS.audience) {
    return {
      ok: false,
      error: `Pick at most ${FORM_LIMITS.audience} people.`,
    }
  }
  if (audience === 'selected' && audienceUserIds.length === 0) {
    return { ok: false, error: 'Pick at least one person, or send it to everyone.' }
  }

  const rawQuestions: unknown[] = Array.isArray(raw.questions)
    ? raw.questions
    : []

  if (rawQuestions.length === 0) {
    return { ok: false, error: 'Add at least one question.' }
  }
  if (rawQuestions.length > FORM_LIMITS.questions) {
    return {
      ok: false,
      error: `A form can hold at most ${FORM_LIMITS.questions} questions.`,
    }
  }

  const questions: NormalisedFormQuestion[] = []

  for (const [index, rawQuestion] of rawQuestions.entries()) {
    if (!rawQuestion || typeof rawQuestion !== 'object') {
      return { ok: false, error: `Question ${index + 1} could not be read.` }
    }

    const question = rawQuestion as Partial<FormQuestionDraft>
    if (!isQuestionType(question.type)) {
      return { ok: false, error: `Question ${index + 1} has an unknown type.` }
    }

    const prompt = trimmed(question.prompt)
    if (!prompt) {
      return { ok: false, error: `Question ${index + 1} needs a prompt.` }
    }
    if (prompt.length > FORM_LIMITS.prompt) {
      return {
        ok: false,
        error: `Question ${index + 1} is longer than ${FORM_LIMITS.prompt} characters.`,
      }
    }

    const help = trimmedOrNull(question.help)
    if (help && help.length > FORM_LIMITS.help) {
      return {
        ok: false,
        error: `Question ${index + 1}'s help line is too long.`,
      }
    }

    let options: string[] = []
    if (needsOptions(question.type)) {
      const rawOptions = Array.isArray(question.options) ? question.options : []
      options = rawOptions
        .filter((option): option is string => typeof option === 'string')
        .map((option) => option.trim())
        .filter(Boolean)

      if (options.length < 2) {
        return {
          ok: false,
          error: `Question ${index + 1} needs at least two options.`,
        }
      }
      if (options.length > FORM_LIMITS.options) {
        return {
          ok: false,
          error: `Question ${index + 1} can have at most ${FORM_LIMITS.options} options.`,
        }
      }
      if (options.some((option) => option.length > FORM_LIMITS.option)) {
        return {
          ok: false,
          error: `Question ${index + 1} has an option longer than ${FORM_LIMITS.option} characters.`,
        }
      }

      const seen = new Set<string>()
      for (const option of options) {
        const key = option.toLowerCase()
        if (seen.has(key)) {
          return {
            ok: false,
            error: `Question ${index + 1} has two identical options.`,
          }
        }
        seen.add(key)
      }
    }

    const scaleLowLabel =
      question.type === 'scale' ? trimmedOrNull(question.scaleLowLabel) : null
    const scaleHighLabel =
      question.type === 'scale' ? trimmedOrNull(question.scaleHighLabel) : null

    if (
      (scaleLowLabel && scaleLowLabel.length > FORM_LIMITS.scaleLabel) ||
      (scaleHighLabel && scaleHighLabel.length > FORM_LIMITS.scaleLabel)
    ) {
      return {
        ok: false,
        error: `Question ${index + 1}'s scale labels are too long.`,
      }
    }

    questions.push({
      type: question.type,
      prompt,
      help,
      required: question.required === true,
      options,
      scaleLowLabel,
      scaleHighLabel,
    })
  }

  return {
    ok: true,
    value: { title, description, audience, audienceUserIds, questions },
  }
}

/**
 * Validate submitted answers against the stored questions.
 *
 * Answers that are empty and optional are dropped rather than stored as an empty
 * string: an empty answer and no answer are the same thing to the person who
 * filled the form in, and the results page should not have to count both.
 */
export function validateFormAnswers(
  questions: AnswerableQuestion[],
  input: unknown,
): Result<NormalisedAnswer[]> {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'That answer could not be read.' }
  }

  const byQuestion = new Map<string, FormAnswerInput>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'That answer could not be read.' }
    }

    const answer = raw as Partial<FormAnswerInput>
    if (typeof answer.questionId !== 'string') {
      return { ok: false, error: 'That answer could not be read.' }
    }
    if (byQuestion.has(answer.questionId)) {
      return { ok: false, error: 'That answer was sent twice.' }
    }
    byQuestion.set(answer.questionId, answer as FormAnswerInput)
  }

  const known = new Set(questions.map((question) => question.id))
  for (const questionId of byQuestion.keys()) {
    if (!known.has(questionId)) {
      return {
        ok: false,
        error:
          'This form changed while you were answering it. Reload and try again.',
      }
    }
  }

  const answers: NormalisedAnswer[] = []

  for (const question of questions) {
    const answer = byQuestion.get(question.id)
    const label = `\u201c${question.prompt}\u201d`

    if (!answer) {
      if (question.required) {
        return { ok: false, error: `Answer the required question ${label}.` }
      }
      continue
    }

    if (question.type === 'short-text' || question.type === 'long-text') {
      const text = typeof answer.text === 'string' ? answer.text.trim() : ''
      if (!text) {
        if (question.required) {
          return { ok: false, error: `Answer the required question ${label}.` }
        }
        continue
      }

      const limit =
        question.type === 'short-text'
          ? FORM_LIMITS.shortText
          : FORM_LIMITS.longText
      if (text.length > limit) {
        return {
          ok: false,
          error: `Keep the answer to ${label} under ${limit} characters.`,
        }
      }

      answers.push({ questionId: question.id, text, number: null, choices: null })
      continue
    }

    if (question.type === 'scale') {
      const value = answer.number
      if (value === null || value === undefined) {
        if (question.required) {
          return { ok: false, error: `Answer the required question ${label}.` }
        }
        continue
      }
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        !(FORM_SCALE_VALUES as readonly number[]).includes(value)
      ) {
        return { ok: false, error: `Choose a value from 1 to 5 for ${label}.` }
      }

      answers.push({
        questionId: question.id,
        text: null,
        number: value,
        choices: null,
      })
      continue
    }

    if (question.type === 'yes-no') {
      const text = trimmed(answer.text).toLowerCase()
      if (!text) {
        if (question.required) {
          return { ok: false, error: `Answer the required question ${label}.` }
        }
        continue
      }
      if (text !== 'yes' && text !== 'no') {
        return { ok: false, error: `Answer yes or no for ${label}.` }
      }

      answers.push({
        questionId: question.id,
        text,
        number: null,
        choices: null,
      })
      continue
    }

    if (question.type === 'choice') {
      const text = trimmed(answer.text)
      if (!text) {
        if (question.required) {
          return { ok: false, error: `Answer the required question ${label}.` }
        }
        continue
      }
      if (!question.options.includes(text)) {
        return { ok: false, error: `Pick one of the options for ${label}.` }
      }

      answers.push({
        questionId: question.id,
        text,
        number: null,
        choices: null,
      })
      continue
    }

    // multi-choice
    const rawChoices = Array.isArray(answer.choices) ? answer.choices : []
    const choices = [
      ...new Set(
        rawChoices
          .filter((choice): choice is string => typeof choice === 'string')
          .map((choice) => choice.trim())
          .filter(Boolean),
      ),
    ]

    if (choices.length === 0) {
      if (question.required) {
        return { ok: false, error: `Answer the required question ${label}.` }
      }
      continue
    }
    if (choices.some((choice) => !question.options.includes(choice))) {
      return { ok: false, error: `Pick from the options for ${label}.` }
    }

    // Store in the question's own order so two identical selections produce the
    // same answer, whatever order the browser sent them in.
    const ordered = question.options.filter((option) => choices.includes(option))
    answers.push({
      questionId: question.id,
      text: null,
      number: null,
      choices: ordered,
    })
  }

  return { ok: true, value: answers }
}
