/**
 * What the results page and the CSV are allowed to show.
 *
 * Tallies keep the question's option order (so a bar chart is stable between
 * renders), free text stays newest first, and the CSV quotes every cell because
 * the answers are user input — including the ones that start with `=`.
 */

import { describe, expect, test } from 'bun:test'

import { buildFormCsv, tallyAnswers } from './results.ts'
import type { ResultResponse } from './results.ts'
import type { FormQuestionView } from './validation.ts'

function question(
  id: string,
  type: FormQuestionView['type'],
  options: string[] = [],
): FormQuestionView {
  return {
    id,
    key: `q-${id}`,
    position: 0,
    type,
    prompt: `Prompt ${id}`,
    help: null,
    required: false,
    options,
    scaleLowLabel: null,
    scaleHighLabel: null,
  }
}

const choice = question('choice', 'choice', ['Composer', 'Inbox'])
const multi = question('multi', 'multi-choice', ['Drafts', 'Topics', 'Search'])
const scale = question('scale', 'scale')
const text = question('text', 'long-text')

const responses: ResultResponse[] = [
  {
    userId: 'ada@example.com',
    submittedAt: new Date('2026-10-20T10:00:00Z'),
    updatedAt: new Date('2026-10-20T10:00:00Z'),
    answers: [
      { questionId: 'choice', text: 'Composer', number: null, choices: null },
      {
        questionId: 'multi',
        text: null,
        number: null,
        choices: ['Drafts', 'Search'],
      },
      { questionId: 'scale', text: null, number: 4, choices: null },
      {
        questionId: 'text',
        text: '=HYPERLINK("http://example.com")',
        number: null,
        choices: null,
      },
    ],
  },
  {
    userId: 'bob@example.com',
    submittedAt: new Date('2026-10-21T10:00:00Z'),
    updatedAt: new Date('2026-10-21T10:00:00Z'),
    answers: [
      { questionId: 'choice', text: 'Inbox', number: null, choices: null },
      { questionId: 'multi', text: null, number: null, choices: ['Drafts'] },
      { questionId: 'scale', text: null, number: 5, choices: null },
      {
        questionId: 'text',
        text: 'Needs a comma, and "quotes"',
        number: null,
        choices: null,
      },
    ],
  },
]

describe('tallyAnswers', () => {
  test('counts choice and multi-choice in option order', () => {
    const tallies = tallyAnswers([choice, multi], responses)

    expect(tallies[0].counts).toEqual([
      { option: 'Composer', count: 1 },
      { option: 'Inbox', count: 1 },
    ])
    expect(tallies[1].counts).toEqual([
      { option: 'Drafts', count: 2 },
      { option: 'Topics', count: 0 },
      { option: 'Search', count: 1 },
    ])
  })

  test('averages answered scales and ignores unanswered ones', () => {
    const [tally] = tallyAnswers([scale], responses)

    expect(tally.answered).toBe(2)
    expect(tally.scaleCounts).toEqual([0, 0, 0, 1, 1])
    expect(tally.average).toBe(4.5)
  })

  test('shows free text newest first and leaves it out of the counts', () => {
    const [tally] = tallyAnswers([text], responses)

    expect(tally.counts).toBeNull()
    expect(tally.texts?.map((entry) => entry.userId)).toEqual([
      'bob@example.com',
      'ada@example.com',
    ])
  })

  test('an unanswered optional question is present with zero answers', () => {
    const [tally] = tallyAnswers([scale], [])
    expect(tally.answered).toBe(0)
    expect(tally.average).toBeNull()
  })
})

describe('buildFormCsv', () => {
  test('writes a header per key and one quoted row per response', () => {
    const { filename, csv } = buildFormCsv({
      title: 'Saved replies: the check-in',
      questions: [choice, scale],
      responses,
    })

    expect(filename).toBe('saved-replies-the-check-in.csv')

    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(
      '"user","submitted_at","updated_at","q-choice: Prompt choice","q-scale: Prompt scale"',
    )
    expect(lines[1]).toContain('"ada@example.com"')
    expect(lines[1]).toContain('"Composer"')
    expect(lines[1]).toContain('"4"')
    expect(lines[2]).toContain('"Inbox"')
    expect(lines[2]).toContain('"5"')
    expect(csv.endsWith('\r\n')).toBe(true)
  })

  test('escapes quotes and commas, and defuses formula cells', () => {
    const { csv } = buildFormCsv({
      title: 'Check',
      questions: [text],
      responses,
    })

    expect(csv).toContain('"\'=HYPERLINK(""http://example.com"")"')
    expect(csv).toContain('"Needs a comma, and ""quotes"""')
  })

  test('joins multi-choice answers with a semicolon', () => {
    const { csv } = buildFormCsv({
      title: 'Check',
      questions: [multi],
      responses,
    })

    expect(csv).toContain('"Drafts; Search"')
  })
})
