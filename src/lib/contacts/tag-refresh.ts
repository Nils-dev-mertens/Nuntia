/**
 * Keeping an automatic description true to the people carrying the tag.
 *
 * A description is only useful while it describes the membership it was written
 * from. Tags get a draft when they are created, and the app's own text is rewritten
 * once the log shows the tag changed after the words were written — a project that
 * ended, a group that grew, a person who left. Text the user wrote is never
 * touched, which is the same provenance rule the tags themselves follow.
 *
 * Three deliberate limits:
 *
 * - **A read never drafts.** The page's loader counts stale descriptions; this
 *   module is called from a server function once the page is on screen, so a
 *   model call cannot hold up a render.
 * - **A few at a time.** At most three drafts per visit: a vocabulary that has
 *   been idle for months would otherwise burn a request per tag on the first load.
 * - **Evidence is local.** The prompt is built from the tag, its current text, the
 *   people carrying it and the newest changes to that set. No mail is read here.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { contactContexts, contactTags } from '#/db/schema.ts'
import type { LlmConfig } from '#/lib/ai/llm.ts'
import { getAiPipelineConfig } from '#/lib/ai/settings.ts'

import { suggestContactTagDescription, suggestContactTags } from './tag-ai.ts'
import type { ContactTagMeaningSource } from './tag-ai.ts'
import { tagDescriptionNeedsRefresh } from './tag-name.ts'
import { listContactTagSummary, saveAutoContactTagDescription } from './tags.ts'
import type { ContactTagSummary } from './tags.ts'

/** How many descriptions one visit may rewrite. */
const MAX_DRAFTS_PER_VISIT = 3

/** How many people carrying the tag are worth showing the model. */
const MAX_CARRIERS = 6

export type TagRefreshOutcome = {
  /** The list afterwards, whether or not anything was rewritten. */
  tags: ContactTagSummary[]
  /** How many descriptions were actually rewritten. */
  updated: number
}

/**
 * Bring the app's own descriptions up to date.
 *
 * The stale ones are picked with the same pure rule the loader counts with, so
 * the two can never disagree about what needed doing.
 */
export async function refreshStaleTagDescriptions(
  userId: string,
): Promise<TagRefreshOutcome> {
  const tags = await listContactTagSummary(userId)
  const stale = tags
    .filter((entry) =>
      tagDescriptionNeedsRefresh({
        source: entry.descriptionSource,
        lastChangeAt: entry.lastChangeAt,
        updatedAt: entry.updatedAt,
        contacts: entry.contacts,
      }),
    )
    .slice(0, MAX_DRAFTS_PER_VISIT)

  if (stale.length === 0) return { tags, updated: 0 }

  let updated = 0
  for (const entry of stale) {
    try {
      const drafted = await draftTagDescription(userId, entry)
      if (!drafted) continue
      if (await saveAutoContactTagDescription(userId, entry.tag, drafted)) {
        updated += 1
      }
    } catch (error) {
      // One failed draft must not stop the others, and the old text is still
      // true enough to be readable.
      console.error('[contact-tags] could not refresh a description:', error)
    }
  }

  return {
    tags: updated > 0 ? await listContactTagSummary(userId) : tags,
    updated,
  }
}

/**
 * Draft a description for a tag that was just created.
 *
 * Returns the list, or null when nothing could be drafted (no LLM configured, a
 * model error, an empty answer) — the tag itself is already saved by then, so a
 * failure here only means the row keeps its empty field.
 */
export async function autoDraftNewTag(
  userId: string,
  tag: string,
): Promise<ContactTagSummary[] | null> {
  try {
    const tags = await listContactTagSummary(userId)
    const entry = tags.find(
      (item) => item.tag.toLowerCase() === tag.trim().toLowerCase(),
    )
    if (!entry) return tags

    const drafted = await draftTagDescription(userId, entry)
    if (!drafted) return tags
    return saveAutoContactTagDescription(userId, entry.tag, drafted)
  } catch (error) {
    console.error(
      '[contact-tags] could not draft a new tag description:',
      error,
    )
    return null
  }
}

/**
 * Propose tags the address book does not have yet.
 *
 * The evidence is the relationship summaries already on file, ordered by
 * importance: a tag is how the user files people, so the proposal is about the
 * shape of the address book rather than about one thread. Words the user already
 * has are filtered out here as well as in the prompt — a model that restates an
 * existing tag should cost nothing.
 */
export async function suggestNewTags(
  userId: string,
  config: LlmConfig,
): Promise<string[]> {
  const owner = userId.trim().toLowerCase()
  const [existing, profiles] = await Promise.all([
    listContactTagSummary(owner),
    db
      .select({
        email: contactContexts.email,
        roleCompany: contactContexts.roleCompany,
        relationship: contactContexts.relationship,
        summary: contactContexts.summary,
      })
      .from(contactContexts)
      .where(eq(contactContexts.userId, owner))
      .orderBy(desc(contactContexts.importance))
      .limit(24),
  ])

  const contacts = profiles.filter(
    (profile) => profile.roleCompany || profile.relationship || profile.summary,
  )
  if (contacts.length === 0) return []

  const proposed = await suggestContactTags(config, {
    existing: existing.map((entry) => entry.tag),
    contacts: contacts.map((profile) => ({
      name: profile.email,
      roleCompany: profile.roleCompany,
      relationship: profile.relationship,
      summary: profile.summary,
    })),
  })

  const known = new Set(existing.map((entry) => entry.tag.trim().toLowerCase()))
  return proposed.filter((tag) => !known.has(tag.trim().toLowerCase()))
}

/** Build the evidence for one tag and ask the configured model for a sentence. */
async function draftTagDescription(
  userId: string,
  entry: ContactTagSummary,
): Promise<string | null> {
  const owner = userId.trim().toLowerCase()
  const config = await getAiPipelineConfig(owner)
  if (!config.llm) return null

  const source: ContactTagMeaningSource = {
    tag: entry.tag,
    current: entry.description,
    examples: await carriersOf(owner, entry.tag),
    changes: entry.recentChanges.map((change) => ({
      email: change.email,
      action: change.action,
      source: change.source,
    })),
  }

  return suggestContactTagDescription(config.llm, source)
}

/**
 * The people carrying a tag, with what the app already understands about them.
 *
 * Names come from the profile's own words rather than another lookup: the
 * relationship summary is what makes "who is this tag for" answerable, and an
 * address alone would only repeat the tag back.
 */
async function carriersOf(
  owner: string,
  tag: string,
): Promise<ContactTagSourceExample[]> {
  const holders = await db
    .select({ email: contactTags.email })
    .from(contactTags)
    .where(
      and(
        eq(contactTags.userId, owner),
        sql`lower(${contactTags.tag}) = ${tag.trim().toLowerCase()}`,
      ),
    )
    .limit(MAX_CARRIERS)

  if (holders.length === 0) return []

  const profiles = await db
    .select({
      email: contactContexts.email,
      roleCompany: contactContexts.roleCompany,
      relationship: contactContexts.relationship,
      summary: contactContexts.summary,
    })
    .from(contactContexts)
    .where(
      and(
        eq(contactContexts.userId, owner),
        inArray(
          contactContexts.email,
          holders.map((row) => row.email),
        ),
      ),
    )
  const byEmail = new Map(profiles.map((profile) => [profile.email, profile]))

  return holders.map((holder) => {
    const profile = byEmail.get(holder.email)
    const description =
      [profile?.roleCompany, profile?.relationship ?? profile?.summary]
        .filter((part): part is string => Boolean(part))
        .join(' — ') || null
    return { name: holder.email, description }
  })
}

type ContactTagSourceExample = {
  name: string | null
  description: string | null
}
