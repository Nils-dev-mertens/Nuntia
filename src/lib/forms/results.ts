/**
 * Turning stored answers into the two things an operator reads: a tally per
 * question and a CSV.
 *
 * Pure on purpose — the admin route loads rows, this module decides what they
 * mean, and the tests point here. Choice counts, scale averages and free text
 * are different shapes because they answer different questions; flattening them
 * into one "results" blob is how a results page becomes unreadable.
 */

import type { FormQuestionView, NormalisedAnswer } from './validation.ts'

export type ResultResponse = {
  userId: string
  submittedAt: Date
  updatedAt: Date
  answers: NormalisedAnswer[]
}

export type QuestionTally = {
  id: string
  prompt: string
  type: FormQuestionView['type']
  /** Responses that answered this question (it may be optional). */
  answered: number
  /** Choice / multi-choice / yes-no. */
  counts: Array<{ option: string; count: number }> | null
  /** Scale only, one entry per value from 1 to 5. */
  scaleCounts: number[] | null
  average: number | null
  /** Short and long text only, newest first. */
  texts: Array<{ userId: string; text: string }> | null
}

/** Count answers per question, keeping the question's own option order. */
export function tallyAnswers(
  questions: FormQuestionView[],
  responses: ResultResponse[],
): QuestionTally[] {
  return questions.map((question) => {
    const answers = responses.flatMap((response) =>
      response.answers
        .filter((answer) => answer.questionId === question.id)
        .map((answer) => ({ userId: response.userId, answer })),
    )

    if (question.type === 'short-text' || question.type === 'long-text') {
      return {
        id: question.id,
        prompt: question.prompt,
        type: question.type,
        answered: answers.length,
        counts: null,
        scaleCounts: null,
        average: null,
        texts: answers
          .filter(
            (
              entry,
            ): entry is {
              userId: string
              answer: NormalisedAnswer & { text: string }
            } => typeof entry.answer.text === 'string',
          )
          .map((entry) => ({ userId: entry.userId, text: entry.answer.text }))
          .reverse(),
      }
    }

    if (question.type === 'scale') {
      const scaleCounts = [0, 0, 0, 0, 0]
      let total = 0
      for (const { answer } of answers) {
        if (typeof answer.number !== 'number') continue
        const index = answer.number - 1
        if (index < 0 || index >= scaleCounts.length) continue
        scaleCounts[index] += 1
        total += answer.number
      }

      const answered = scaleCounts.reduce((sum, count) => sum + count, 0)

      return {
        id: question.id,
        prompt: question.prompt,
        type: question.type,
        answered,
        counts: null,
        scaleCounts,
        average: answered > 0 ? Math.round((total / answered) * 10) / 10 : null,
        texts: null,
      }
    }

    const options = question.type === 'yes-no' ? ['yes', 'no'] : question.options
    const counts = options.map((option) => ({ option, count: 0 }))

    for (const { answer } of answers) {
      if (question.type === 'multi-choice') {
        for (const choice of answer.choices ?? []) {
          const entry = counts.find((candidate) => candidate.option === choice)
          if (entry) entry.count += 1
        }
        continue
      }

      const entry = counts.find((candidate) => candidate.option === answer.text)
      if (entry) entry.count += 1
    }

    return {
      id: question.id,
      prompt: question.prompt,
      type: question.type,
      answered: answers.length,
      counts,
      scaleCounts: null,
      average: null,
      texts: null,
    }
  })
}

function csvCell(value: string): string {
  // A cell beginning with =, +, - or @ is a formula to a spreadsheet. Answers
  // are user input, so prefixing an apostrophe is the cheap way to keep Excel
  // from executing one.
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${guarded.replace(/"/g, '""')}"`
}

/** One row per response, one column per question, RFC-4180 quoting. */
export function buildFormCsv(input: {
  title: string
  questions: FormQuestionView[]
  responses: ResultResponse[]
}): { filename: string; csv: string } {
  const header = [
    'user',
    'submitted_at',
    'updated_at',
    ...input.questions.map((question) => `${question.key}: ${question.prompt}`),
  ]

  const lines = [header.map(csvCell).join(',')]

  for (const response of input.responses) {
    const cells = [
      response.userId,
      response.submittedAt.toISOString(),
      response.updatedAt.toISOString(),
      ...input.questions.map((question) => {
        const answer = response.answers.find(
          (candidate) => candidate.questionId === question.id,
        )
        if (!answer) return ''
        if (answer.choices) return answer.choices.join('; ')
        if (typeof answer.number === 'number') return String(answer.number)
        return answer.text ?? ''
      }),
    ]

    lines.push(cells.map(csvCell).join(','))
  }

  const slug =
    input.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'form'

  return { filename: `${slug}.csv`, csv: `${lines.join('\r\n')}\r\n` }
}
