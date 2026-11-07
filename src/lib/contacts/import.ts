/**
 * Importing a client list by hand.
 *
 * The same shape the organisation webhook will accept, without the token:
 * addresses, one per line, each optionally followed by a kind. Only the kind is
 * written — relationship, topics, current work and importance stay the member's
 * own notes, and an address already in the list keeps every one of them. That is
 * the whole point of the split: an import says who the company works with, never
 * what anyone thinks of them.
 */

import { db } from '#/db/index.ts'
import { organizationClients } from '#/db/schema.ts'
import { ensureWorkspace } from '#/lib/organization/workspace.ts'

import { CONTACT_KINDS, isContactKind } from './context.ts'
import type { ContactKind } from './context.ts'
import { normaliseContactEmail } from './matching.ts'

/**
 * Upper bound on one import.
 *
 * A pasted list is a human action with a real CRM export behind it, so this is
 * generous; it exists to refuse a runaway paste rather than to limit a customer
 * list. Anything beyond it is reported as unread instead of silently dropped.
 */
export const CONTACT_IMPORT_LIMIT = 2000

export const CONTACT_IMPORT_DEFAULT_KIND: ContactKind = 'client'

export type ContactImportEntry = { email: string; kind: ContactKind }

export type ParsedContactImport = {
  entries: ContactImportEntry[]
  /** Lines that were not an address, named an unknown kind, or came after the limit. */
  skipped: string[]
}

/** Column names a pasted CSV starts with, which are not failed addresses. */
const HEADER_WORDS = new Set([
  'email',
  'e-mail',
  'email address',
  'address',
  'contact',
  'mail',
])

function looksLikeAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

/**
 * Read a kind from the second column.
 *
 * The label is matched against the same closed list the picker offers, so
 * `Client`, `client` and `" Client "` are one value and a company name in that
 * column is refused rather than quietly treated as the fallback — the wrong kind
 * is worse than a skipped line, because it changes who is prioritised.
 */
function kindFromLabel(label: string): ContactKind | null {
  const value = label
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
  return isContactKind(value) ? value : null
}

/**
 * Parse a pasted list.
 *
 * One address per line, optionally `address, kind` (a comma, semicolon or tab).
 * Blank lines, `#` comments and a header row are ignored; a duplicate address is
 * kept once, first occurrence wins, so pasting the same export twice is safe.
 */
export function parseContactImport(
  text: string,
  fallbackKind: ContactKind = CONTACT_IMPORT_DEFAULT_KIND,
): ParsedContactImport {
  const entries: ContactImportEntry[] = []
  const skipped: string[] = []
  const seen = new Set<string>()

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const [first, ...rest] = line.split(/[,;\t]/)
    const address = first.trim()
    const label = rest.join(' ').trim()

    if (HEADER_WORDS.has(address.toLowerCase())) continue

    const email = normaliseContactEmail(address)
    const kind = label === '' ? fallbackKind : kindFromLabel(label)
    if (!looksLikeAddress(email) || !kind) {
      skipped.push(line)
      continue
    }
    if (seen.has(email)) continue
    if (entries.length >= CONTACT_IMPORT_LIMIT) {
      skipped.push(line)
      continue
    }

    seen.add(email)
    entries.push({ email, kind })
  }

  return { entries, skipped }
}

/**
 * Write the parsed kinds into the member's workspace, one address at a time.
 *
 * This writes the client list and nothing else: `contact_contexts` — the notes —
 * is never touched, so importing cannot overwrite what someone wrote. The list
 * belongs to the organisation, which is what makes one import serve every member.
 * Returns how many addresses were written.
 */
export async function importContactKinds(
  userId: string,
  entries: readonly ContactImportEntry[],
): Promise<number> {
  const workspace = await ensureWorkspace(userId)
  if (!workspace) return 0

  let written = 0
  for (const entry of entries) {
    const email = normaliseContactEmail(entry.email)
    if (!looksLikeAddress(email) || !isContactKind(entry.kind)) continue

    const updatedAt = new Date()
    await db
      .insert(organizationClients)
      .values({
        organizationId: workspace.organizationId,
        email,
        kind: entry.kind,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [organizationClients.organizationId, organizationClients.email],
        set: { kind: entry.kind, updatedAt },
      })
    written += 1
  }
  return written
}

/** The kinds a pasted column may name, for the error the import reports. */
export const CONTACT_IMPORT_KIND_NAMES = CONTACT_KINDS.join(', ')
