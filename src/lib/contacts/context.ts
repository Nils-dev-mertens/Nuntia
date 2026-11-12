/** User-authored context about correspondents, shared across their mailboxes. */

import { and, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { contactContexts } from '#/db/schema.ts'
import type { ContactContextSources } from '#/db/schema.ts'

import { normaliseContactEmail } from './matching.ts'

export type ContactContext = {
  email: string
  roleCompany: string
  relationship: string
  topics: string
  currentWork: string
  /** One or two plain sentences; this is what the conversation view shows. */
  summary: string
  importance: number | null
  /** Which fields the app wrote, so a user's own edit is never overwritten. */
  sources: ContactContextSources
}

export type ContactContextFields = Omit<
  ContactContext,
  'email' | 'summary' | 'sources'
>
export type ContactContextTextFields = Omit<ContactContextFields, 'importance'>
export type ContactDecisionContext = ContactContextFields & {
  /** Absent on callers that only build the four notes. */
  summary?: string
  /** The tags already on this person, so a refresh reuses them rather than
   * inventing near-duplicates. Not written through this shape. */
  tags?: string[]
}

/**
 * What a model proposes: the four private notes plus the short description the
 * user actually reads. Kept together so one refresh writes both.
 */
export type ContactContextProposal = ContactContextTextFields & {
  summary?: string
  /**
   * Tags the model proposes, when the answer carried any.
   *
   * Absent means "the prompt said nothing about tags", which must not clear the
   * ones already stored; an empty array means "none fit", which does. The
   * writer distinguishes the two, and only ever touches tags it wrote itself.
   */
  tags?: string[]
}

export const CONTACT_CONTEXT_LIMITS = {
  roleCompany: 160,
  relationship: 500,
  topics: 1000,
  currentWork: 1000,
  summary: 280,
  importance: 10,
} as const

/** The summary is derived, so an overlong one is cut rather than refused. */
export function normaliseContactSummary(
  value: string | null | undefined,
): string {
  return (value ?? '').trim().slice(0, CONTACT_CONTEXT_LIMITS.summary)
}

export function normaliseContactContextTextFields(
  input: ContactContextTextFields,
): ContactContextTextFields | null {
  const fields = {
    roleCompany: input.roleCompany.trim(),
    relationship: input.relationship.trim(),
    topics: input.topics.trim(),
    currentWork: input.currentWork.trim(),
  }

  if (
    fields.roleCompany.length > CONTACT_CONTEXT_LIMITS.roleCompany ||
    fields.relationship.length > CONTACT_CONTEXT_LIMITS.relationship ||
    fields.topics.length > CONTACT_CONTEXT_LIMITS.topics ||
    fields.currentWork.length > CONTACT_CONTEXT_LIMITS.currentWork
  ) {
    return null
  }
  return fields
}

export function normaliseContactContextFields(
  input: ContactContextFields,
): ContactContextFields | null {
  const textFields = normaliseContactContextTextFields(input)
  const importance = input.importance
  if (
    !textFields ||
    (importance !== null &&
      (!Number.isInteger(importance) ||
        importance < 1 ||
        importance > CONTACT_CONTEXT_LIMITS.importance))
  ) {
    return null
  }
  return { ...textFields, importance }
}

export async function listContactDecisionContextByEmail(
  userId: string,
): Promise<Map<string, ContactDecisionContext>> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return new Map()

  const rows = await db
    .select()
    .from(contactContexts)
    .where(eq(contactContexts.userId, owner))
  return new Map(
    rows.map((row) => [
      row.email,
      {
        roleCompany: row.roleCompany ?? '',
        relationship: row.relationship ?? '',
        topics: row.topics ?? '',
        currentWork: row.currentWork ?? '',
        importance: row.importance,
        summary: row.summary ?? '',
      },
    ]),
  )
}

export async function listContactImportanceByEmail(
  userId: string,
): Promise<Map<string, number>> {
  const contexts = await listContactDecisionContextByEmail(userId)
  return new Map(
    [...contexts].flatMap(([email, context]) =>
      context.importance === null ? [] : [[email, context.importance] as const],
    ),
  )
}

export async function getContactContext(
  userId: string,
  email: string,
): Promise<ContactContext | null> {
  const owner = userId.trim().toLowerCase()
  const address = normaliseContactEmail(email)
  if (!owner || !address) return null

  const row = await db.query.contactContexts.findFirst({
    where: and(
      eq(contactContexts.userId, owner),
      eq(contactContexts.email, address),
    ),
  })

  return row ? toContactContext(row) : null
}

/** Map one stored row into the shape the app passes around. */
function toContactContext(
  row: typeof contactContexts.$inferSelect,
): ContactContext {
  return {
    email: row.email,
    roleCompany: row.roleCompany ?? '',
    relationship: row.relationship ?? '',
    topics: row.topics ?? '',
    currentWork: row.currentWork ?? '',
    summary: row.summary ?? '',
    importance: row.importance,
    sources: row.sources ?? {},
  }
}

/** Every profile this user holds, for the contacts directory. */
export async function listContactContexts(
  userId: string,
): Promise<ContactContext[]> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return []

  const rows = await db
    .select()
    .from(contactContexts)
    .where(eq(contactContexts.userId, owner))
  return rows.map(toContactContext)
}

export async function saveContactContext(
  userId: string,
  email: string,
  input: ContactContextFields,
): Promise<ContactContext | null> {
  const owner = userId.trim().toLowerCase()
  const address = normaliseContactEmail(email)
  const fields = normaliseContactContextFields(input)
  if (!owner || !address || !fields) return null

  const values = {
    roleCompany: fields.roleCompany || null,
    relationship: fields.relationship || null,
    topics: fields.topics || null,
    currentWork: fields.currentWork || null,
    importance: fields.importance,
    updatedAt: new Date(),
  }
  const empty =
    fields.importance === null &&
    [
      fields.roleCompany,
      fields.relationship,
      fields.topics,
      fields.currentWork,
    ].every((value) => value.length === 0)

  if (empty) {
    await db
      .delete(contactContexts)
      .where(
        and(
          eq(contactContexts.userId, owner),
          eq(contactContexts.email, address),
        ),
      )
    return null
  }

  await db
    .insert(contactContexts)
    .values({ userId: owner, email: address, ...values })
    .onConflictDoUpdate({
      target: [contactContexts.userId, contactContexts.email],
      set: values,
    })

  // Read back rather than rebuilding: a manual save must preserve the summary
  // and provenance the app wrote, and those live only in the row.
  return getContactContext(owner, address)
}
