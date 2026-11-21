/**
 * Spam handling: the user's rules, what their actions taught the app, and the
 * conservative scorer that fills the gaps between the two.
 */

import {
  listSpamRules,
  listSpamSenders,
  matchingSpamRules,
  normaliseSenderAddress,
} from './repository.ts'
import type { SpamRule } from './fields.ts'
import { judgeSpam } from './score.ts'

export {
  addSpamRule,
  listSpamRules,
  listSpamSenders,
  matchingSpamRules,
  normaliseSenderAddress,
  normaliseSpamRules,
  recordSpamSender,
  removeSpamRule,
  saveSpamRules,
} from './repository.ts'
export { SPAM_RULE_FIELDS, SPAM_RULE_LIMITS } from './fields.ts'
export type { SpamRule, SpamRuleField } from './fields.ts'
export type { SpamRuleTarget } from './repository.ts'
export {
  judgeSpam,
  spamScore,
  spamSignals,
  SPAM_SCORE_THRESHOLD,
} from './score.ts'
export type { SpamInput, SpamSignal, SpamVerdict } from './score.ts'

/** What the sync reads once per batch. */
export type SpamFacts = {
  rules: SpamRule[]
  /** Senders the user has filed as spam and not brought back. */
  learnedSenders: ReadonlySet<string>
}

/** Never throws: a failed read costs spam filtering, not the sync. */
export async function loadSpamFacts(
  accountId: string,
  userId: string,
): Promise<SpamFacts> {
  const [rules, learnedSenders] = await Promise.all([
    listSpamRules(userId).catch(() => [] as SpamRule[]),
    listSpamSenders(accountId).catch(() => new Set<string>()),
  ])
  return { rules, learnedSenders }
}

/**
 * Decide whether one message should be filed as spam.
 *
 * The caller passes a message from someone else; the owner's own mail is never
 * spam, and neither is a thread whose only mail is automated unless a rule or a
 * learned sender says so.
 */
export function judgeMessage(
  message: {
    from: string
    fromName?: string | null
    subject: string
    body: string
  },
  facts: SpamFacts,
): ReturnType<typeof judgeSpam> {
  const from = normaliseSenderAddress(message.from)
  const ruleReasons = matchingSpamRules(facts.rules, {
    from,
    subject: message.subject,
  }).map((rule) => `matches your spam rule "${rule.value}"`)

  return judgeSpam(message, {
    ruleReasons,
    learnedSender: from !== '' && facts.learnedSenders.has(from),
  })
}
