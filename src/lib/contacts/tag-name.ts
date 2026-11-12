/**
 * The pure half of contact tags: the rules for what a tag is.
 *
 * Split from `tags.ts` for the same reason `matching.ts` is split from the
 * contacts barrel — the prompt builders and the tests need these rules without
 * pulling the database into their import graph.
 */

export const CONTACT_TAG_LIMITS = {
  /** Long enough for "waiting on procurement", short enough for a chip. */
  tag: 32,
  /** Beyond this the chips are noise rather than a way to find someone. */
  perContact: 20,
  /**
   * How many a model may propose in one refresh.
   *
   * Five is a filing decision, not a summary: the point is that a person is
   * findable by a few stable words, and a dozen tags would neither be read nor
   * kept current.
   */
  perProposal: 5,
  /**
   * A sentence, not an essay: enough to say what the word means, short enough
   * to sit under a tag in a list without turning the list into prose.
   */
  description: 240,
} as const

/**
 * One tag, as it will be stored, or null when the input is not a tag.
 *
 * A leading `#` is accepted and dropped because that is how people write tags,
 * and inner runs of whitespace collapse so "waiting  on   legal" and
 * "waiting on legal" are one tag. Case is preserved for display; the writers
 * compare case-insensitively so they cannot create both spellings.
 */
export function normaliseContactTag(value: string): string | null {
  const tag = value.trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim()

  if (tag.length === 0 || tag.length > CONTACT_TAG_LIMITS.tag) return null
  return tag
}

/**
 * A model's tag list, cleaned into what would be stored.
 *
 * Anything that is not a string, is not a usable tag, or is a case-only repeat
 * of one already in the list is dropped rather than rejected: a proposal with
 * one bad word is still a proposal, and the caller never has to reason about
 * partial validity.
 */
export function normaliseContactTagList(
  raw: unknown,
  limit: number = CONTACT_TAG_LIMITS.perProposal,
): string[] {
  if (!Array.isArray(raw)) return []

  const seen = new Set<string>()
  const tags: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = normaliseContactTag(item)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue

    seen.add(key)
    tags.push(tag)
    if (tags.length >= limit) break
  }
  return tags
}

/**
 * A tag's description, as it will be stored.
 *
 * Whitespace collapses so a pasted paragraph arrives as one clean line, and the
 * ends are trimmed. An empty string is a real answer — it means "no
 * description" and the caller deletes the row rather than storing a blank —
 * while `null` means the text was longer than a description should be.
 */
export function normaliseContactTagDescription(value: string): string | null {
  const description = value.replace(/\s+/g, ' ').trim()
  if (description.length > CONTACT_TAG_LIMITS.description) return null
  return description
}

/**
 * What is known about a tag's description, for deciding whether it is stale.
 *
 * Pure, so the rule is the same in the page's loader (which only counts) and in
 * the server function that rewrites the sentence.
 */
export type TagDescriptionState = {
  /** Who wrote the current text; null when there is none. */
  source: 'auto' | 'user' | null
  /** Epoch ms of the newest membership change, if any. */
  lastChangeAt: number | null
  /** Epoch ms of the last write to the text, if any. */
  updatedAt: number | null
  /** How many contacts carry the tag. */
  contacts: number
}

/**
 * Whether the app should draft this description again.
 *
 * Three rules, each with a reason:
 *
 * - Text the user wrote is never touched. Their wording is theirs, exactly like
 *   a tag they typed by hand.
 * - Text the app wrote is refreshed only when the tag's membership changed after
 *   it was written, which is when it stopped describing the people carrying it.
 * - A tag with no text at all is worth describing once somebody carries it; a
 *   bare word on its own has nothing to be grounded in yet.
 */
export function tagDescriptionNeedsRefresh(
  state: TagDescriptionState,
): boolean {
  if (state.source === 'user') return false
  if (state.source === 'auto') {
    return (
      state.updatedAt !== null &&
      state.lastChangeAt !== null &&
      state.lastChangeAt > state.updatedAt
    )
  }
  return state.contacts > 0
}

/** Stable, human order: the chips should not reshuffle between saves. */
export function sortContactTags(tags: Iterable<string>): string[] {
  return [...new Set(tags)].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  )
}

/** Whether two spellings are the same tag for uniqueness purposes. */
export function sameContactTag(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}
