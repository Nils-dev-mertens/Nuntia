/**
 * The shape of a spam rule, shared by the sync and the settings editor.
 *
 * Kept out of `#/db/schema.ts` because the editor renders a control per field
 * and the schema is server-only (it holds the encrypted column types, which
 * import `node:crypto`). Importing these values from the schema — or from the
 * repository that re-exports them — put the encryption module in the browser
 * bundle. The schema re-exports them for server code.
 */

/** The tests a spam rule may run against a message. */
export const SPAM_RULE_FIELDS = [
  'sender-email',
  'sender-domain',
  'subject-contains',
] as const

export type SpamRuleField = (typeof SPAM_RULE_FIELDS)[number]

/** Shared with the editor so the form and the validator agree. */
export const SPAM_RULE_LIMITS = { count: 50, value: 200 } as const

/** One stored rule, in the order the editor lists it. */
export type SpamRule = {
  id: string
  field: SpamRuleField
  value: string
}
