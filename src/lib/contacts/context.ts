/** User-authored context about correspondents, shared across their mailboxes. */

import { and, eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { contactContexts, organizationClients } from '#/db/schema.ts'
import { ensureWorkspace } from '#/lib/organization/workspace.ts'

import { normaliseContactEmail } from './matching.ts'

/**
 * What a correspondent is to the user.
 *
 * A closed list rather than free text: the inbox acts on one of these values
 * (a `client` leaves the state groups for the Clients section), and a typo is a
 * person who silently stops being prioritised. Adding a kind is a code change
 * and no migration — the column is plain text.
 */
export const CONTACT_KINDS = [
  'client',
  'prospect',
  'vendor',
  'partner',
  'colleague',
  'investor',
  'personal',
  'other',
] as const

export type ContactKind = (typeof CONTACT_KINDS)[number]

/** Names for the picker and the Clients list, in the order they are offered. */
export const CONTACT_KIND_LABELS: Record<ContactKind, string> = {
  client: 'Client',
  prospect: 'Prospect',
  vendor: 'Vendor',
  partner: 'Partner',
  colleague: 'Colleague',
  investor: 'Investor',
  personal: 'Personal',
  other: 'Other',
}

export function isContactKind(value: unknown): value is ContactKind {
  return (
    typeof value === 'string' &&
    (CONTACT_KINDS as readonly string[]).includes(value)
  )
}

export type ContactContext = {
  email: string
  kind: ContactKind | null
  roleCompany: string
  relationship: string
  topics: string
  currentWork: string
  importance: number | null
}

export type ContactContextFields = Omit<ContactContext, 'email'>
/** What the AI is asked to suggest: the notes, never the facts the user owns. */
export type ContactContextTextFields = Omit<
  ContactContextFields,
  'importance' | 'kind'
>
export type ContactDecisionContext = ContactContextFields

export const CONTACT_CONTEXT_LIMITS = {
  roleCompany: 160,
  relationship: 500,
  topics: 1000,
  currentWork: 1000,
  importance: 10,
} as const

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
  const kind = input.kind ?? null
  if (
    !textFields ||
    (kind !== null && !isContactKind(kind)) ||
    (importance !== null &&
      (!Number.isInteger(importance) ||
        importance < 1 ||
        importance > CONTACT_CONTEXT_LIMITS.importance))
  ) {
    return null
  }
  return { ...textFields, kind, importance }
}

/** A row's stored kind, or null for anything the current code does not know. */
function readKind(value: string | null): ContactKind | null {
  return isContactKind(value) ? value : null
}

/**
 * The organisation's client kinds, keyed by address.
 *
 * One read for both questions the inbox asks: who is a client (to build the
 * section), and what someone is (to pass to the decision model).
 */
async function clientKindsFor(
  organizationId: string,
): Promise<Map<string, ContactKind>> {
  const rows = await db
    .select({
      email: organizationClients.email,
      kind: organizationClients.kind,
    })
    .from(organizationClients)
    .where(eq(organizationClients.organizationId, organizationId))

  return new Map(
    rows.flatMap((row) => {
      const kind = readKind(row.kind)
      return kind ? [[row.email, kind] as const] : []
    }),
  )
}

export async function listContactDecisionContextByEmail(
  userId: string,
): Promise<Map<string, ContactDecisionContext>> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return new Map()

  const workspace = await ensureWorkspace(owner)
  const rows = await db
    .select()
    .from(contactContexts)
    .where(eq(contactContexts.userId, owner))
  const kinds = workspace
    ? await clientKindsFor(workspace.organizationId)
    : new Map<string, ContactKind>()

  const contexts = new Map<string, ContactDecisionContext>(
    rows.map((row) => [
      row.email,
      {
        kind: kinds.get(row.email) ?? null,
        roleCompany: row.roleCompany ?? '',
        relationship: row.relationship ?? '',
        topics: row.topics ?? '',
        currentWork: row.currentWork ?? '',
        importance: row.importance,
      },
    ]),
  )

  // A colleague's import names a client this member has never written about: the
  // writer has no row here, but the address still carries a kind.
  for (const [email, kind] of kinds) {
    if (contexts.has(email)) continue
    contexts.set(email, {
      kind,
      roleCompany: '',
      relationship: '',
      topics: '',
      currentWork: '',
      importance: null,
    })
  }

  return contexts
}

/**
 * Every correspondent with a kind in the member's workspace, keyed by address.
 *
 * Read through the workspace rather than the user: the client list is the
 * organisation's, so a colleague's import prioritises the address in this inbox
 * too. Their notes are not part of this answer — those never leave the row of the
 * person who wrote them.
 */
export async function listContactKindsByEmail(
  userId: string,
): Promise<Map<string, ContactKind>> {
  const workspace = await ensureWorkspace(userId)
  if (!workspace) return new Map()
  return clientKindsFor(workspace.organizationId)
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

  const workspace = await ensureWorkspace(owner)
  const row = await db.query.contactContexts.findFirst({
    where: and(
      eq(contactContexts.userId, owner),
      eq(contactContexts.email, address),
    ),
  })
  const client = workspace
    ? await db.query.organizationClients.findFirst({
        where: and(
          eq(organizationClients.organizationId, workspace.organizationId),
          eq(organizationClients.email, address),
        ),
      })
    : undefined

  const kind = readKind(client?.kind ?? null)
  if (!row) {
    // Someone else in the workspace imported them: the address is a client with
    // no notes of this member's, which is still worth showing in the sidebar.
    return kind
      ? {
          email: address,
          kind,
          roleCompany: '',
          relationship: '',
          topics: '',
          currentWork: '',
          importance: null,
        }
      : null
  }

  return {
    email: row.email,
    kind,
    roleCompany: row.roleCompany ?? '',
    relationship: row.relationship ?? '',
    topics: row.topics ?? '',
    currentWork: row.currentWork ?? '',
    importance: row.importance,
  }
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

  const workspace = await ensureWorkspace(owner)
  if (!workspace) return null

  // Two writers for two owners: the kind is the workspace's, the notes are this
  // member's. A save therefore never overwrites the other side — changing a kind
  // leaves every note alone, and clearing notes cannot unmark a client.
  const updatedAt = new Date()
  if (fields.kind) {
    await db
      .insert(organizationClients)
      .values({
        organizationId: workspace.organizationId,
        email: address,
        kind: fields.kind,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [organizationClients.organizationId, organizationClients.email],
        set: { kind: fields.kind, updatedAt },
      })
  } else {
    // Unmarking is a workspace decision too: the address stops being a client
    // for everyone, because a list where one person's clear leaves the client
    // showing in someone else's inbox would be a list nobody could trust.
    await db
      .delete(organizationClients)
      .where(
        and(
          eq(organizationClients.organizationId, workspace.organizationId),
          eq(organizationClients.email, address),
        ),
      )
  }

  const values = {
    roleCompany: fields.roleCompany || null,
    relationship: fields.relationship || null,
    topics: fields.topics || null,
    currentWork: fields.currentWork || null,
    importance: fields.importance,
    updatedAt,
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
    // Nothing of this member's is left. With no kind either the profile is gone;
    // with one, the workspace still knows the address and that is all there is to
    // show.
    return fields.kind
      ? {
          email: address,
          kind: fields.kind,
          roleCompany: '',
          relationship: '',
          topics: '',
          currentWork: '',
          importance: null,
        }
      : null
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
    kind: fields.kind,
    roleCompany: fields.roleCompany,
    relationship: fields.relationship,
    topics: fields.topics,
    currentWork: fields.currentWork,
    importance: fields.importance,
  }
}
