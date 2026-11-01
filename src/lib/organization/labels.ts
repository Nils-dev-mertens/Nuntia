/**
 * The words the user sees for the four state labels.
 *
 * The four states are fixed — every stored row, the decision layer and the
 * database column speak in those values. What is user-owned is how they read:
 * the name in the heading and badge, and the meaning/purpose line under the
 * heading. Custom sections have their own name and meaning and live with the
 * organization rules; this module only resolves the built-in four.
 */

import { CONVERSATION_STATES } from '#/db/schema.ts'
import type { ConversationState } from '#/db/schema.ts'
import { STATE_META } from '#/lib/conversation-state.ts'

export type StateLabel = { name: string; description: string }
export type StateLabels = Record<ConversationState, StateLabel>

/**
 * The state meanings the user has rewritten, keyed by state.
 *
 * A partial map because most people never edit a label, and the decision prompt
 * should not pay to read back the app's own default copy.
 */
export type StateDefinitions = Partial<Record<ConversationState, string>>

export const STATE_LABEL_LIMITS = {
  name: 40,
  description: 300,
} as const

/**
 * How many corrections one label needs before a rewritten meaning is proposed.
 *
 * Three: one is a misfiled thread, two is a coincidence, and the first two would
 * otherwise be enough to rewrite a definition on very little evidence.
 *
 * Here rather than beside the proposal code on purpose. This module is pure —
 * schema constants and the app's own copy — while `state-meaning.ts` opens the
 * database. The settings page prints this number in its markup, and a value
 * import from a database module at render time is not stripped by the
 * server-function transform: it drags `createClient({ url: 'file:…' })` into the
 * browser bundle, where libsql refuses the scheme.
 */
export const STATE_MEANING_MIN_CORRECTIONS = 3

/** What a label reads as before the user has changed it. */
export function defaultStateLabels(): StateLabels {
  return Object.fromEntries(
    CONVERSATION_STATES.map((state) => [
      state,
      {
        name: STATE_META[state].label,
        description: STATE_META[state].description,
      },
    ]),
  ) as StateLabels
}

/** Defaults with the user's stored overrides applied. */
export function resolveStateLabels(
  overrides: Partial<Record<ConversationState, StateLabel>>,
): StateLabels {
  const labels = defaultStateLabels()

  for (const state of CONVERSATION_STATES) {
    const override = overrides[state]
    if (override) {
      labels[state] = {
        name: override.name,
        description: override.description,
      }
    }
  }

  return labels
}

/**
 * The overrides worth storing, given a full set of labels.
 *
 * A label left at its default is not written: storing the current copy verbatim
 * is how a later wording improvement would never reach anyone who once opened
 * this page.
 */
export function stateLabelOverrides(
  labels: StateLabels,
): Array<{ state: ConversationState } & StateLabel> {
  const defaults = defaultStateLabels()

  return CONVERSATION_STATES.filter(
    (state) =>
      labels[state].name !== defaults[state].name ||
      labels[state].description !== defaults[state].description,
  ).map((state) => ({ state, ...labels[state] }))
}

/**
 * The labels this user has put into their own words, for the decision prompt.
 *
 * "Needs action" is not the same claim for a support desk and a founder, so a
 * meaning the user rewrote has to travel with the thread. Only changed labels
 * are returned: an untouched label is the app's own copy, and sending it would
 * spend tokens restating the default.
 */
export function customStateMeanings(labels: StateLabels): StateDefinitions {
  const defaults = defaultStateLabels()
  const meanings: StateDefinitions = {}

  for (const state of CONVERSATION_STATES) {
    const description = labels[state].description.trim()
    if (description && description !== defaults[state].description) {
      meanings[state] = description
    }
  }

  return meanings
}

/**
 * Validate and normalise a submitted set of labels.
 *
 * All four are required, each exactly once. A missing label would otherwise
 * silently fall back to a default the user cannot see on the form, and a
 * duplicate is a page bug rather than a choice. An empty meaning is allowed —
 * some labels may not need one — but a label without a name is not a label.
 */
export function normaliseStateLabels(
  input: unknown,
): Array<{ state: ConversationState } & StateLabel> | null {
  if (!Array.isArray(input) || input.length !== CONVERSATION_STATES.length) {
    return null
  }

  const seen = new Set<ConversationState>()
  const labels: Array<{ state: ConversationState } & StateLabel> = []

  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') return null
    const entry = candidate as Record<string, unknown>
    if (
      typeof entry.state !== 'string' ||
      !(CONVERSATION_STATES as readonly string[]).includes(entry.state) ||
      typeof entry.name !== 'string' ||
      typeof entry.description !== 'string'
    ) {
      return null
    }

    const state = entry.state as ConversationState
    const name = entry.name.trim()
    const description = entry.description.trim()

    if (
      seen.has(state) ||
      !name ||
      name.length > STATE_LABEL_LIMITS.name ||
      description.length > STATE_LABEL_LIMITS.description
    ) {
      return null
    }

    seen.add(state)
    labels.push({ state, name, description })
  }

  return labels
}
