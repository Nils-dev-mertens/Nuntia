/**
 * The short relationship description, with no database in the import graph.
 *
 * The contact page and the contacts directory render this value in the browser.
 * Importing it from `context.ts` would pull `db` — and `createClient({ url:
 * 'file:…' })` — into the client bundle, where libsql refuses the file scheme.
 * The fields are declared structurally so this module has no runtime imports at
 * all; a stored `ContactContext` fits it as-is.
 */

export type ContactDescriptionFields = {
  summary: string
  roleCompany: string
  relationship: string
  topics: string
  currentWork: string
}

/**
 * The stored summary first; older rows and hand-written notes have none, so the
 * first two facts stand in rather than showing a blank line.
 */
export function contactContextDescription(
  context: ContactDescriptionFields | null,
): string | null {
  if (!context) return null
  if (context.summary.trim()) return context.summary.trim()

  const parts = [
    context.roleCompany,
    context.relationship,
    context.topics,
    context.currentWork,
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return parts.length > 0 ? parts.slice(0, 2).join(' · ') : null
}
