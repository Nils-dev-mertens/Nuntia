/**
 * The context revision log.
 *
 * Two jobs, and both need the value a write *replaced* rather than only the value
 * it left: an Undo, and the correction signal that teaches the app what a label
 * means to this person. Neither can be reconstructed from the current row — it
 * only holds the new value — so every write has to go through here.
 *
 * `source` is the part that makes the log worth keeping. `auto` alone is a
 * changelog; `user` right after an `auto` is a correction, and a run of
 * corrections in one direction is the only honest evidence of what the label
 * means to this user.
 *
 * Deliberately small and pruned per target: a safety net plus a correction log,
 * not an audit trail of everything the app has ever thought.
 */

import { and, desc, eq, notInArray } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { contactContexts, contextRevisions, conversations } from '#/db/schema.ts'
import type {
  ContextRevision,
  ContextRevisionScope,
  ContextRevisionSource,
  ConversationState,
} from '#/db/schema.ts'
import type { ContactContextTextFields } from '#/lib/contacts/context.ts'
import { withWriteLock } from '#/lib/db/write-lock.ts'

/** How many revisions one target keeps. A safety net, not an audit log. */
export const CONTEXT_REVISION_LIMIT = 20

const CONTACT_FIELDS = [
  'roleCompany',
  'relationship',
  'topics',
  'currentWork',
] as const

type ContactField = (typeof CONTACT_FIELDS)[number]

/** The transaction handle Drizzle hands to `db.transaction`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type ContextRevisionInput = {
  userId: string
  scope: ContextRevisionScope
  target: string
  field: string
  previousValue: string | null
  nextValue: string | null
  source: ContextRevisionSource
  threadId?: string | null
}

/** An empty string and no value are the same thing in these columns. */
function stored(value: string): string | null {
  const trimmed = value.trim()
  return trimmed || null
}

/**
 * What one automatic refresh wants to change, with the values it replaces.
 *
 * The caller supplies the previous values because it has already read them: a
 * second read here could see a row the user edited in between, and then the
 * revision would name a value that was never overwritten.
 */
export type AutoContextUpdate = {
  userId: string
  /** `conversations.id` of the thread the update was read from. */
  conversationId: string
  providerThreadId: string
  goal: { previous: string | null; next: string | null }
  /**
   * A custom label the decision layer assigned, or omitted when it assigned none.
   *
   * Written to `conversations.organization_group_id`, which the inbox groups by:
   * the user's own move and this share one column, and the revision row is what
   * tells them apart — and what makes the model's pick undoable.
   */
  label?: { previous: string | null; next: string | null } | null
  contact: {
    email: string
    previous: ContactContextTextFields
    next: ContactContextTextFields
  } | null
}

/**
 * Apply an automatic update and record what it replaced.
 *
 * Only changed fields produce a revision, and only non-empty values are written:
 * an empty field in the proposal means "the thread did not say", never "clear
 * what the user wrote". Returns how many fields changed, which is what the
 * caller logs and what makes a no-op sync look like one.
 */
export async function writeAutoContextUpdate(
  input: AutoContextUpdate,
): Promise<number> {
  const owner = input.userId.trim().toLowerCase()
  if (!owner) return 0

  return withWriteLock(() =>
    db.transaction(async (tx) => {
      const revisions: ContextRevisionInput[] = []

      if (input.goal.next !== null && input.goal.next !== input.goal.previous) {
        await tx
          .update(conversations)
          .set({ goal: input.goal.next, updatedAt: new Date() })
          .where(eq(conversations.id, input.conversationId))

        revisions.push({
          userId: owner,
          scope: 'conversation',
          target: input.conversationId,
          field: 'goal',
          previousValue: input.goal.previous,
          nextValue: input.goal.next,
          source: 'auto',
          threadId: input.providerThreadId,
        })
      }

      if (
        input.label &&
        input.label.next !== null &&
        input.label.next !== input.label.previous
      ) {
        await tx
          .update(conversations)
          .set({
            organizationGroupId: input.label.next,
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, input.conversationId))

        revisions.push({
          userId: owner,
          scope: 'conversation',
          target: input.conversationId,
          field: 'label',
          previousValue: input.label.previous,
          nextValue: input.label.next,
          source: 'auto',
          threadId: input.providerThreadId,
        })
      }

      if (input.contact) {
        const { email, previous, next } = input.contact
        const changed: Partial<Record<ContactField, string>> = {}

        for (const field of CONTACT_FIELDS) {
          const before = stored(previous[field])
          const after = stored(next[field])
          // Unchanged fields write nothing: a sync of thirty threads must not
          // bury the one edit that mattered.
          if (!after || after === before) continue

          changed[field] = after
          revisions.push({
            userId: owner,
            scope: 'contact',
            target: email,
            field,
            previousValue: before,
            nextValue: after,
            source: 'auto',
            threadId: input.providerThreadId,
          })
        }

        if (revisions.length > 0 && Object.keys(changed).length > 0) {
          // Upserted rather than required to exist: a correspondent nobody has
          // written about yet is the normal first case.
          await tx
            .insert(contactContexts)
            .values({
              userId: owner,
              email,
              ...changed,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [contactContexts.userId, contactContexts.email],
              set: { ...changed, updatedAt: new Date() },
            })
        }
      }

      await insertRevisions(tx, revisions)
      return revisions.length
    }),
  )
}

/** The newest revisions for one target, for the "updated from this thread" list. */
export async function listContextRevisions(
  userId: string,
  scope: ContextRevisionScope,
  target: string,
): Promise<ContextRevision[]> {
  const owner = userId.trim().toLowerCase()
  if (!owner || !target) return []

  return db
    .select()
    .from(contextRevisions)
    .where(
      and(
        eq(contextRevisions.userId, owner),
        eq(contextRevisions.scope, scope),
        eq(contextRevisions.target, target),
      ),
    )
    .orderBy(desc(contextRevisions.createdAt))
    .limit(CONTEXT_REVISION_LIMIT)
}

/**
 * One row of the "recent changes" list, flattened for the page.
 *
 * Plain strings rather than the table's dates and enums so the value survives
 * the server-function boundary intact, and `undone` rather than `undoneAt`
 * because the page only ever asks the one question of it.
 */
export type ContextRevisionView = {
  id: string
  scope: ContextRevisionScope
  field: string
  previousValue: string | null
  nextValue: string | null
  source: ContextRevisionSource
  /** The thread's subject for a conversation change; null for a contact one. */
  subject: string | null
  createdAt: string
  undone: boolean
}

/**
 * The newest context changes across every target, for one page to show.
 *
 * The left join is what gives a conversation-scoped row something a human can
 * read: the revision names a conversation id, which means nothing on screen. A
 * contact row's target is an address and simply does not match, which is why the
 * subject is nullable rather than a second query.
 */
export async function listRecentContextRevisions(
  userId: string,
  limit = 20,
): Promise<ContextRevisionView[]> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return []

  const rows = await db
    .select({
      revision: contextRevisions,
      subject: conversations.subject,
    })
    .from(contextRevisions)
    .leftJoin(conversations, eq(conversations.id, contextRevisions.target))
    .where(eq(contextRevisions.userId, owner))
    .orderBy(desc(contextRevisions.createdAt))
    .limit(Math.min(limit, CONTEXT_REVISION_LIMIT))

  return rows.map(({ revision, subject }) => ({
    id: revision.id,
    scope: revision.scope,
    field: revision.field,
    previousValue: revision.previousValue,
    nextValue: revision.nextValue,
    source: revision.source,
    subject,
    createdAt: revision.createdAt.toISOString(),
    undone: revision.undoneAt !== null,
  }))
}

/**
 * Who put a thread in the label it is in: the app, the user, or nobody yet.
 *
 * The one thing the revision log knows that `conversations.organization_group_id`
 * does not — both writers share that column. It is what decides whether a better
 * reading may replace the current one: the app's own filing is provisional, the
 * user's is not.
 */
export async function latestLabelSource(
  userId: string,
  conversationId: string,
): Promise<ContextRevisionSource | null> {
  const owner = userId.trim().toLowerCase()
  if (!owner || !conversationId) return null

  const row = await db.query.contextRevisions.findFirst({
    where: and(
      eq(contextRevisions.userId, owner),
      eq(contextRevisions.scope, 'conversation'),
      eq(contextRevisions.target, conversationId),
      eq(contextRevisions.field, 'label'),
    ),
    orderBy: [desc(contextRevisions.createdAt)],
  })

  return row?.source ?? null
}

/**
 * Record a label change the user made by hand.
 *
 * Without it the app cannot tell its own filing from theirs, since both are one
 * column — and so cannot know which of its own additions are safe to revise.
 * A move that changes nothing writes nothing, the same rule as every other
 * revision.
 */
export async function recordUserLabelChange(input: {
  userId: string
  conversationId: string
  providerThreadId: string
  previous: string | null
  next: string | null
}): Promise<void> {
  const owner = input.userId.trim().toLowerCase()
  if (!owner || input.previous === input.next) return

  await withWriteLock(() =>
    db.transaction(async (tx) => {
      await insertRevisions(tx, [
        {
          userId: owner,
          scope: 'conversation',
          target: input.conversationId,
          field: 'label',
          previousValue: input.previous,
          nextValue: input.next,
          source: 'user',
          threadId: input.providerThreadId,
        },
      ])
    }),
  )
}

/**
 * Put a value back, and record the restoration as a revision of its own.
 *
 * Undo is a write like any other, so undoing twice is not a special case: the
 * second Undo reverses the first. Returns false when the row is gone, already
 * undone, or names a field this does not know how to restore.
 */
export async function undoContextRevision(
  userId: string,
  revisionId: string,
): Promise<boolean> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return false

  return withWriteLock(() =>
    db.transaction(async (tx) => {
      const revision = await tx.query.contextRevisions.findFirst({
        where: and(
          eq(contextRevisions.id, revisionId),
          eq(contextRevisions.userId, owner),
        ),
      })

      if (!revision || revision.undoneAt) return false
      if (!(await restore(tx, owner, revision))) return false

      await tx
        .update(contextRevisions)
        .set({ undoneAt: new Date() })
        .where(eq(contextRevisions.id, revision.id))

      await insertRevisions(tx, [
        {
          userId: owner,
          scope: revision.scope,
          target: revision.target,
          field: revision.field,
          previousValue: revision.nextValue,
          nextValue: revision.previousValue,
          source: 'user',
          threadId: revision.threadId,
        },
      ])

      return true
    }),
  )
}

/** Write the previous value back. Returns false for a field it cannot restore. */
async function restore(
  tx: Tx,
  userId: string,
  revision: ContextRevision,
): Promise<boolean> {
  if (revision.scope === 'contact') {
    if (!(CONTACT_FIELDS as readonly string[]).includes(revision.field)) {
      return false
    }
    const values: Partial<Record<ContactField, string | null>> = {
      [revision.field as ContactField]: revision.previousValue,
    }
    await tx
      .update(contactContexts)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(
          eq(contactContexts.userId, userId),
          eq(contactContexts.email, revision.target),
        ),
      )
    return true
  }

  if (revision.field === 'label') {
    await tx
      .update(conversations)
      .set({ organizationGroupId: revision.previousValue, updatedAt: new Date() })
      .where(eq(conversations.id, revision.target))
    return true
  }

  if (revision.field === 'topic' || revision.field === 'goal') {
    const values =
      revision.field === 'topic'
        ? { topic: revision.previousValue }
        : { goal: revision.previousValue }
    await tx
      .update(conversations)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(conversations.id, revision.target))
    return true
  }

  if (revision.field === 'state') {
    // The call and the state travel together: restoring one without the other
    // would leave a thread showing a label its own override disagrees with.
    const previous = revision.previousValue as ConversationState | null
    await tx
      .update(conversations)
      .set({
        stateOverride: previous,
        stateOverrideMessageAt: new Date(),
        ...(previous ? { state: previous } : {}),
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, revision.target))
    return true
  }

  return false
}

async function insertRevisions(
  tx: Tx,
  revisions: ContextRevisionInput[],
): Promise<void> {
  const targets = new Map<string, ContextRevisionInput>()

  for (const revision of revisions) {
    await tx.insert(contextRevisions).values({
      // The global rather than `node:crypto`: this module is reachable from a
      // route module, and a Node-only import there is one bundler config away
      // from breaking the page.
      id: crypto.randomUUID(),
      userId: revision.userId,
      scope: revision.scope,
      target: revision.target,
      field: revision.field,
      previousValue: revision.previousValue,
      nextValue: revision.nextValue,
      source: revision.source,
      threadId: revision.threadId ?? null,
    })
    targets.set(`${revision.scope}:${revision.target}`, revision)
  }

  for (const revision of targets.values()) {
    await pruneTarget(
      tx,
      revision.userId,
      revision.scope,
      revision.target,
    )
  }
}

/** Keep the newest `CONTEXT_REVISION_LIMIT` rows for one target. */
async function pruneTarget(
  tx: Tx,
  userId: string,
  scope: ContextRevisionScope,
  target: string,
): Promise<void> {
  const keep = await tx
    .select({ id: contextRevisions.id })
    .from(contextRevisions)
    .where(
      and(
        eq(contextRevisions.userId, userId),
        eq(contextRevisions.scope, scope),
        eq(contextRevisions.target, target),
      ),
    )
    .orderBy(desc(contextRevisions.createdAt))
    .limit(CONTEXT_REVISION_LIMIT)

  // `NOT IN ()` is not valid SQL, and an empty set means nothing to prune.
  if (keep.length === 0) return

  await tx
    .delete(contextRevisions)
    .where(
      and(
        eq(contextRevisions.userId, userId),
        eq(contextRevisions.scope, scope),
        eq(contextRevisions.target, target),
        notInArray(
          contextRevisions.id,
          keep.map((row) => row.id),
        ),
      ),
    )
}
