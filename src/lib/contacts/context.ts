/** User-authored context about correspondents, shared across their mailboxes. */

import { and, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { contactContexts } from '#/db/schema.ts'

import { normaliseContactEmail } from './matching.ts'

export type ContactContext = {
  email: string
  roleCompany: string
  relationship: string
  topics: string
  currentWork: string
}

export type ContactContextFields = Omit<ContactContext, 'email'>

export const CONTACT_CONTEXT_LIMITS = {
  roleCompany: 160,
  relationship: 500,
  topics: 1000,
  currentWork: 1000,
} as const

export function normaliseContactContextFields(
  input: ContactContextFields,
): ContactContextFields | null {
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

  return row
    ? {
        email: row.email,
        roleCompany: row.roleCompany ?? '',
        relationship: row.relationship ?? '',
        topics: row.topics ?? '',
        currentWork: row.currentWork ?? '',
      }
    : null
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
    updatedAt: new Date(),
  }
  const empty = Object.values(fields).every((value) => value.length === 0)

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

  return {
    email: address,
    roleCompany: fields.roleCompany,
    relationship: fields.relationship,
    topics: fields.topics,
    currentWork: fields.currentWork,
  }
}
