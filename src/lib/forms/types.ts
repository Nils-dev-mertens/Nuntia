/**
 * The question types a form may use.
 *
 * Kept out of `#/db/schema.ts` because the form builder renders a control per
 * type and the schema is server-only (it holds the encrypted column types,
 * which import `node:crypto`). The schema re-exports the type for server code.
 */
export const FORM_QUESTION_TYPES = [
  'short-text',
  'long-text',
  'choice',
  'multi-choice',
  'scale',
  'yes-no',
] as const

export type FormQuestionType = (typeof FORM_QUESTION_TYPES)[number]
