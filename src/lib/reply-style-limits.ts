/**
 * Limits for the named greeting/signature pairs.
 *
 * Kept separate from `reply-styles.ts` on purpose: the settings form renders
 * these as `maxLength`, so importing them from the store would drag
 * `node:crypto` and the database into the client bundle.
 */
export const REPLY_STYLE_LIMITS = {
  name: 60,
  greeting: 200,
  signature: 1000,
} as const
