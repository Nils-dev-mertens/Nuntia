/**
 * Pure helpers for the contact list.
 *
 * Kept apart from `index.ts` so the composer's recipient field can import them
 * without pulling the database, `node:crypto` or the schema into the browser
 * bundle. Nothing here touches the network or storage.
 */

/** Fold an address the way it is stored and compared. */
export function normaliseContactEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * The suggestions for what has been typed so far.
 *
 * A person is found by name or by address, because the user remembers one and
 * half-types the other. Addresses already committed to the field are dropped, so
 * the list never offers someone twice, and the cap keeps the popup scrollable
 * without the field turning into a directory.
 */
export function matchContactSuggestions<
  T extends { email: string; name: string | null },
>(suggestions: T[], query: string, taken: Iterable<string>, limit = 8): T[] {
  const needle = query.trim().toLowerCase()
  const chosen = new Set(
    [...taken].map((email) => normaliseContactEmail(email)),
  )

  return suggestions
    .filter((suggestion) => {
      if (chosen.has(normaliseContactEmail(suggestion.email))) return false
      if (!needle) return true

      return (
        suggestion.email.toLowerCase().includes(needle) ||
        (suggestion.name ?? '').toLowerCase().includes(needle)
      )
    })
    .slice(0, limit)
}
