/**
 * Storage for the rules that file mail as spam, and for what marking spam
 * teaches the app about a sender.
 *
 * Both are per user, not per thread: a rule is a decision about the future, and
 * a sender mark is the same. The sync reads them once per batch and passes them
 * down, so a backfill does not ask the same two questions per thread.
 */

import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { spamRules, spamSenderSignals } from '#/db/schema.ts'
import { SPAM_RULE_FIELDS, SPAM_RULE_LIMITS } from './fields.ts'
import type { SpamRule, SpamRuleField } from './fields.ts'
import { domainOf } from './score.ts'

/** The message facts a rule can see. */
export type SpamRuleTarget = {
  from: string
  subject: string
}

/** Trimmed, lowercased address; empty when the input is not one. */
export function normaliseSenderAddress(value: string): string {
  const address = value.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : ''
}

export async function listSpamRules(userId: string): Promise<SpamRule[]> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return []

  const rows = await db
    .select()
    .from(spamRules)
    .where(eq(spamRules.userId, owner))
    .orderBy(asc(spamRules.position))

  return rows.map((row) => ({ id: row.id, field: row.field, value: row.value }))
}

/** True when any of these rules matches the message. */
export function matchingSpamRules(
  rules: readonly SpamRule[],
  target: SpamRuleTarget,
): SpamRule[] {
  const from = normaliseSenderAddress(target.from)
  const domain = domainOf(from)
  const subject = target.subject.toLowerCase()

  return rules.filter((rule) => {
    const value = rule.value.trim().toLowerCase()
    if (!value) return false

    switch (rule.field) {
      case 'sender-email':
        return from !== '' && from === normaliseSenderAddress(value)
      case 'sender-domain':
        return domain !== '' && domain === value.replace(/^@/, '')
      case 'subject-contains':
        return subject.includes(value)
    }
  })
}

/**
 * Save the whole rule list, replacing what was there.
 *
 * The form submits the complete set, so a rule removed on screen has to be
 * removed here; the same delete-then-insert the label rules use. Invalid input
 * leaves storage untouched rather than deleting it.
 */
export async function saveSpamRules(
  userId: string,
  input: unknown,
): Promise<SpamRule[] | null> {
  const owner = userId.trim().toLowerCase()
  const rules = normaliseSpamRules(input)
  if (!owner || !rules) return null

  await db.transaction(async (tx) => {
    await tx.delete(spamRules).where(eq(spamRules.userId, owner))
    if (rules.length === 0) return

    await tx.insert(spamRules).values(
      rules.map((rule, position) => ({
        id: rule.id,
        userId: owner,
        field: rule.field,
        value: rule.value,
        position,
        createdAt: new Date(),
      })),
    )
  })

  return rules
}

/** Add one rule; exists for the settings toggle and for tests. */
export async function addSpamRule(
  userId: string,
  field: SpamRuleField,
  value: string,
): Promise<SpamRule | null> {
  const owner = userId.trim().toLowerCase()
  const normalised = normaliseSpamValue(field, value)
  if (!owner || !normalised) return null

  const existing = await listSpamRules(owner)
  if (
    existing.some(
      (rule) =>
        rule.field === field &&
        rule.value.toLowerCase() === normalised.toLowerCase(),
    )
  ) {
    return (
      existing.find(
        (rule) =>
          rule.field === field &&
          rule.value.toLowerCase() === normalised.toLowerCase(),
      ) ?? null
    )
  }

  const rule: SpamRule = { id: randomUUID(), field, value: normalised }
  await db.insert(spamRules).values({
    id: rule.id,
    userId: owner,
    field: rule.field,
    value: rule.value,
    position: existing.length,
    createdAt: new Date(),
  })
  return rule
}

export async function removeSpamRule(
  userId: string,
  ruleId: string,
): Promise<void> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return

  await db
    .delete(spamRules)
    .where(and(eq(spamRules.userId, owner), eq(spamRules.id, ruleId)))
}

/**
 * Senders the user has filed as spam and not since brought back.
 *
 * A set because the only question the sync asks is membership. `notSpamAt`
 * outranks `spamAt` when it is newer, which is what makes "not spam" a real
 * correction rather than a permanent flag.
 */
export async function listSpamSenders(
  accountId: string,
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select()
    .from(spamSenderSignals)
    .where(eq(spamSenderSignals.accountId, accountId))

  return new Set(
    rows
      .filter(
        (row) =>
          row.spamAt !== null &&
          (row.notSpamAt === null ||
            row.spamAt.getTime() > row.notSpamAt.getTime()),
      )
      .map((row) => row.senderEmail),
  )
}

/** Record that the user called this sender's mail spam, or took that back. */
export async function recordSpamSender(
  accountId: string,
  senderEmail: string,
  spam: boolean,
): Promise<void> {
  const address = normaliseSenderAddress(senderEmail)
  if (!address) return

  const now = new Date()
  await db
    .insert(spamSenderSignals)
    .values({
      id: randomUUID(),
      accountId,
      senderEmail: address,
      spamAt: spam ? now : null,
      notSpamAt: spam ? null : now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [spamSenderSignals.accountId, spamSenderSignals.senderEmail],
      set: spam
        ? { spamAt: now, updatedAt: now }
        : { notSpamAt: now, updatedAt: now },
    })
}

/**
 * Validate a whole rule list arriving from the browser.
 *
 * Null means "not a rule list" rather than "no rules": the caller has to leave
 * the stored rules alone when the payload is malformed, and only an explicitly
 * empty array may clear them.
 */
export function normaliseSpamRules(input: unknown): SpamRule[] | null {
  if (!Array.isArray(input)) return null

  const seen = new Set<string>()
  const rules: SpamRule[] = []

  for (const item of input) {
    if (rules.length >= SPAM_RULE_LIMITS.count) break
    if (!item || typeof item !== 'object') continue
    const raw = item as { id?: unknown; field?: unknown; value?: unknown }
    if (typeof raw.field !== 'string') continue
    if (!SPAM_RULE_FIELDS.includes(raw.field as SpamRuleField)) continue
    if (typeof raw.value !== 'string') continue

    const field = raw.field as SpamRuleField
    const value = normaliseSpamValue(field, raw.value)
    if (!value) continue

    const key = `${field}:${value.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)

    rules.push({
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : randomUUID(),
      field,
      value,
    })
  }

  return rules
}

function normaliseSpamValue(field: SpamRuleField, value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''

  if (field === 'sender-email') return normaliseSenderAddress(trimmed)
  if (field === 'sender-domain')
    return domainOf(`x@${trimmed.replace(/^@/, '')}`)
  return trimmed.slice(0, SPAM_RULE_LIMITS.value)
}
