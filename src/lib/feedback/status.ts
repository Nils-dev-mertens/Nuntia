/**
 * The states a piece of feedback can be in.
 *
 * Kept out of `#/db/schema.ts` because the operator UI filters by these values
 * and the schema is server-only (it holds the encrypted column types, which
 * import `node:crypto`). The schema re-exports the type for server code.
 */
export const FEEDBACK_STATUSES = [
  'new',
  'read',
  'planned',
  'fixed',
  'declined',
] as const

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]
