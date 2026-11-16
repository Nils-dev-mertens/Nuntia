/**
 * The stored half of an organisation: the one thing a domain cannot say.
 *
 * Everything else about an organisation is derived from the address, so this
 * module is deliberately small — a description, where it came from, and a
 * suggestion the user has not answered yet. Nothing here is ever written from a
 * guess: the refresh may quote the mail, but only the user turns a quote into the
 * description.
 */

import { and, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { contactOrganizations } from '#/db/schema.ts'
import type { OrganizationFocusSource } from '#/db/schema.ts'

import {
  contactOrganization,
  normaliseOrganizationFocus,
} from './organization.ts'

/** One company as the address book holds it, merged with the derived group. */
export type OrganizationRecord = {
  domain: string
  /** What the company does, as the user or a line of mail put it. */
  focus: string | null
  /** Where the accepted wording came from; null when there is no description. */
  source: OrganizationFocusSource | null
  /** A mail-stated line waiting for the user to accept or dismiss it. */
  suggestedFocus: string | null
}

/** Every description this user has written or kept, keyed by domain. */
export async function listOrganizationRecords(
  userId: string,
): Promise<Map<string, OrganizationRecord>> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return new Map()

  const rows = await db
    .select()
    .from(contactOrganizations)
    .where(eq(contactOrganizations.userId, owner))

  return new Map(
    rows.map((row) => [
      row.domain,
      {
        domain: row.domain,
        focus: row.focus,
        source: row.focusSource,
        suggestedFocus: row.suggestedFocus,
      },
    ]),
  )
}

/**
 * Write the user's own description, or clear it.
 *
 * An empty value clears both the description and any pending suggestion: the
 * user has just said there is nothing to keep, so a queued quote must not
 * reappear. The wording is marked `user`, which is what stops a later refresh
 * from replacing it.
 */
export async function setOrganizationFocus(
  userId: string,
  domain: string,
  focus: string,
): Promise<boolean> {
  const owner = userId.trim().toLowerCase()
  const key = knownDomain(domain)
  if (!owner || !key) return false

  const text = normaliseOrganizationFocus(focus)
  await upsert(owner, key, {
    focus: text || null,
    focusSource: text ? 'user' : null,
    suggestedFocus: null,
  })
  return true
}

/**
 * Keep the mail-stated line as the description.
 *
 * The source stays `mail`: accepting says the wording is right, not that the
 * user wrote it, and the screen can still show where it came from.
 */
export async function acceptOrganizationFocusSuggestion(
  userId: string,
  domain: string,
): Promise<boolean> {
  const owner = userId.trim().toLowerCase()
  const key = knownDomain(domain)
  if (!owner || !key) return false

  const row = await db.query.contactOrganizations.findFirst({
    where: and(
      eq(contactOrganizations.userId, owner),
      eq(contactOrganizations.domain, key),
    ),
  })
  if (!row?.suggestedFocus) return false

  await db
    .update(contactOrganizations)
    .set({
      focus: row.suggestedFocus,
      focusSource: 'mail',
      suggestedFocus: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(contactOrganizations.userId, owner),
        eq(contactOrganizations.domain, key),
      ),
    )
  return true
}

/** Drop one queued line without changing the description. */
export async function dismissOrganizationFocusSuggestion(
  userId: string,
  domain: string,
): Promise<boolean> {
  const owner = userId.trim().toLowerCase()
  const key = knownDomain(domain)
  if (!owner || !key) return false

  await db
    .update(contactOrganizations)
    .set({ suggestedFocus: null, updatedAt: new Date() })
    .where(
      and(
        eq(contactOrganizations.userId, owner),
        eq(contactOrganizations.domain, key),
      ),
    )
  return true
}

/**
 * Queue a description the mail stated, for the user to accept.
 *
 * Called from the automatic refresh, so it is best-effort and quiet: a failure
 * here must cost the suggestion, not the profile write that carries it. It never
 * touches an accepted description the user wrote, and it does not queue the line
 * that is already accepted or already waiting.
 */
export async function suggestOrganizationFocus(
  userId: string,
  email: string,
  focus: string,
): Promise<void> {
  const owner = userId.trim().toLowerCase()
  const organization = contactOrganization(email)
  const text = normaliseOrganizationFocus(focus)
  if (!owner || !organization || !text) return

  const row = await db.query.contactOrganizations.findFirst({
    where: and(
      eq(contactOrganizations.userId, owner),
      eq(contactOrganizations.domain, organization.domain),
    ),
  })
  if (row?.focusSource === 'user') return
  if (row?.focus === text || row?.suggestedFocus === text) return

  await upsert(owner, organization.domain, { suggestedFocus: text })
}

/** A stored domain is only ever the registrable one, or nothing. */
function knownDomain(value: string): string | null {
  const domain = value.trim().toLowerCase()
  if (!domain || domain.includes('@')) return null
  return contactOrganization(`postmaster@${domain}`)?.domain ?? null
}

async function upsert(
  userId: string,
  domain: string,
  values: Partial<{
    focus: string | null
    focusSource: OrganizationFocusSource | null
    suggestedFocus: string | null
  }>,
): Promise<void> {
  await db
    .insert(contactOrganizations)
    .values({ userId, domain, ...values, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [contactOrganizations.userId, contactOrganizations.domain],
      set: { ...values, updatedAt: new Date() },
    })
}
