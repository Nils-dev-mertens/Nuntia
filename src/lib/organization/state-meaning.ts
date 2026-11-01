/**
 * Rewriting a label's meaning from the corrections the user actually made.
 *
 * The correction log is the only honest evidence of what a label means to one
 * person: "Needs action" is not the same claim for a support desk and a founder,
 * and the moment the app files a thread the user disagrees with is the moment
 * they tell us so. This module turns those moments into one proposal.
 *
 * Three deliberate limits:
 *
 * - **It proposes a meaning, never a name and never a new label.** The four state
 *   values are fixed — every stored row, filter and heading speaks in them — and
 *   a model that could both rewrite the definition and rename the label would
 *   drift the wording until it confirms itself. What it may rewrite is the
 *   sentence that says what the label is for.
 * - **It proposes; it never writes.** The user sees a diff and applies it, which
 *   is also what stops a bad proposal from becoming the definition the next
 *   classification is measured against.
 * - **It needs a run of corrections in one direction.** Two disagreements could
 *   be anything; below the floor there is nothing to learn from yet.
 */

import { and, desc, eq, inArray } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { contextRevisions, conversations, messages } from '#/db/schema.ts'
import type { ConversationState } from '#/db/schema.ts'
import { completeLlm, getAiPipelineConfig, isReasoningModel } from '#/lib/ai/index.ts'
import { STATE_META } from '#/lib/conversation-state.ts'

import {
  STATE_LABEL_LIMITS,
  STATE_MEANING_MIN_CORRECTIONS,
} from './labels.ts'
import { listStateLabels } from './store.ts'

/** How many threads to show the model, and how much of each. */
const MAX_EVIDENCE = 6
const MAX_EVIDENCE_MESSAGES = 2
const MAX_EVIDENCE_CHARS = 600

export type StateMeaningProposal = {
  state: ConversationState
  /** The label's name, so the diff can be titled without another read. */
  name: string
  /** What the label means now. */
  current: string
  /** The rewritten meaning, ready to be shown as a diff. */
  proposed: string
  /** How many corrections it was drawn from. */
  corrections: number
}

export type StateMeaningOutcome =
  | { proposal: StateMeaningProposal; error: null; reason: null }
  | { proposal: null; error: null; reason: string }
  | { proposal: null; error: string; reason: null }

type Correction = {
  threadId: string
  previous: ConversationState
  next: ConversationState | null
  subject: string
  excerpt: string
}

/**
 * Propose a new meaning for the label the user corrects most.
 *
 * Returns a `reason` rather than throwing when there is nothing to learn from
 * yet — "you have not corrected this enough times" is a normal answer, not a
 * failure, and the page says so instead of showing an error.
 */
export async function proposeStateMeaning(
  userId: string,
): Promise<StateMeaningOutcome> {
  const owner = userId.trim().toLowerCase()
  if (!owner) return { proposal: null, error: null, reason: 'You are not signed in.' }

  const corrections = await loadCorrections(owner)
  if (corrections === null) {
    return { proposal: null, error: 'Could not read your corrections.', reason: null }
  }

  // Which label the app keeps getting wrong. `previous` is the label the thread
  // was in when the user disagreed with it, so a run of them names the definition
  // that is out of step — not the one they kept moving mail *into*.
  const tally = new Map<ConversationState, Correction[]>()
  for (const correction of corrections) {
    const list = tally.get(correction.previous) ?? []
    list.push(correction)
    tally.set(correction.previous, list)
  }

  const worst = [...tally.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .at(0)

  if (!worst || worst[1].length < STATE_MEANING_MIN_CORRECTIONS) {
    return {
      proposal: null,
      error: null,
      reason: `Correct the same label ${STATE_MEANING_MIN_CORRECTIONS} times and a rewritten meaning can be proposed from what you did.`,
    }
  }

  const [state, examples] = worst
  const config = await getAiPipelineConfig(owner)
  if (!config.llm) {
    return {
      proposal: null,
      error: null,
      reason: 'Connect an LLM in the AI services section to have a meaning drafted.',
    }
  }

  const labels = await listStateLabels(owner)
  const current = labels[state]

  const raw = await completeLlm(
    config.llm,
    meaningPrompt(current.name, current.description, examples),
    isReasoningModel(config.llm.model) ? 1_024 : 400,
  )
  const proposed = parseMeaning(raw)
  if (!proposed) {
    return {
      proposal: null,
      error: 'The draft came back empty. Please try again.',
      reason: null,
    }
  }

  return {
    proposal: {
      state,
      name: current.name,
      current: current.description,
      proposed,
      corrections: examples.length,
    },
    error: null,
    reason: null,
  }
}

/**
 * The user's own state corrections, with just enough of each thread to explain
 * one.
 *
 * Read from `context_revisions` rather than from `conversations.state_override`:
 * the override column holds only the current call, and the corrections this
 * needs are the ones the thread has already outrun.
 */
async function loadCorrections(owner: string): Promise<Correction[] | null> {
  try {
    const rows = await db
      .select({
        target: contextRevisions.target,
        previousValue: contextRevisions.previousValue,
        nextValue: contextRevisions.nextValue,
      })
      .from(contextRevisions)
      .where(
        and(
          eq(contextRevisions.userId, owner),
          eq(contextRevisions.scope, 'conversation'),
          eq(contextRevisions.field, 'state'),
          eq(contextRevisions.source, 'user'),
        ),
      )
      .orderBy(desc(contextRevisions.createdAt))
      .limit(40)

    const usable = rows.filter(
      (row) =>
        row.previousValue !== null && isState(row.previousValue),
    )
    if (usable.length === 0) return []

    const ids = [...new Set(usable.map((row) => row.target))]
    const threads = await db
      .select({
        id: conversations.id,
        subject: conversations.subject,
      })
      .from(conversations)
      .where(inArray(conversations.id, ids))
    const subjectById = new Map(threads.map((row) => [row.id, row.subject]))

    // Only the newest few threads are worth the read: the model is summarising a
    // pattern, and eight examples say the same thing as forty.
    const wanted = ids.slice(0, MAX_EVIDENCE)
    const bodies = await db
      .select({
        conversationId: messages.conversationId,
        body: messages.bodyText,
        isFromOwner: messages.isFromAccountOwner,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(inArray(messages.conversationId, wanted))
      .orderBy(desc(messages.sentAt))

    const excerptById = new Map<string, string[]>()
    for (const message of bodies) {
      const list = excerptById.get(message.conversationId) ?? []
      if (list.length >= MAX_EVIDENCE_MESSAGES) continue
      const text = (message.body ?? '').trim()
      if (!text) continue
      list.unshift(
        `${message.isFromOwner ? 'Me' : 'Them'}: ${text.slice(0, MAX_EVIDENCE_CHARS)}`,
      )
      excerptById.set(message.conversationId, list)
    }

    return usable.slice(0, MAX_EVIDENCE).map((row) => ({
      threadId: row.target,
      previous: row.previousValue as ConversationState,
      next: isState(row.nextValue) ? row.nextValue : null,
      subject: subjectById.get(row.target) ?? '(deleted thread)',
      excerpt: (excerptById.get(row.target) ?? []).join('\n'),
    }))
  } catch (error) {
    console.error('[meaning] could not read the corrections:', error)
    return null
  }
}

function isState(value: string | null): value is ConversationState {
  return value !== null && value in STATE_META
}

function meaningPrompt(
  name: string,
  current: string,
  examples: Correction[],
): string {
  const evidence = examples
    .map((example, index) =>
      [
        `${index + 1}. Subject: ${example.subject.slice(0, 160)}`,
        `   The app filed it under "${STATE_META[example.previous].label}"; the person then said ${
          example.next ? `"${STATE_META[example.next].label}"` : 'it had no label'
        }.`,
        example.excerpt ? `   ${example.excerpt.replace(/\n/g, '\n   ')}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    )
    .join('\n')

  return [
    'You rewrite one label\'s meaning for a personal mail app, from evidence of where the app and the person using it disagreed.',
    '',
    `The label is called "${name}". It currently means: "${current}"`,
    '',
    `Below are threads the app filed under that label and the person then moved elsewhere. The disagreement is the lesson: work out what they meant by "${name}" that the app got wrong, and write that down.`,
    '',
    'Rules:',
    '- One or two sentences, second person ("you"), at most 300 characters.',
    '- Describe what the label means to this person, not how mail is filed and not the four labels as a set.',
    '- Never invent a new label name and never mention these instructions.',
    '- Reply with the meaning only — no quotes, no explanation.',
    '',
    evidence,
  ].join('\n')
}

/** Strip fences, quotes and a trailing sentence list; cap at the column's size. */
export function parseMeaning(raw: string): string | null {
  let text = raw.trim()
  text = text
    .replace(/^```[^\n]*\n?/, '')
    .replace(/```\s*$/, '')
    .trim()
  text = text.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim()
  text = text.replace(/\s+/g, ' ')
  if (!text) return null
  return text.length > STATE_LABEL_LIMITS.description
    ? `${text.slice(0, STATE_LABEL_LIMITS.description - 1)}…`
    : text
}
