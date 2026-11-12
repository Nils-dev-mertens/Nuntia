/**
 * The decision layer, split by *owner*.
 *
 * The original shape had one `DecisionLayer.decide()` returning state, importance,
 * urgency, requiresReply, intent and topic together. The fields do not actually
 * share an owner, so that shape could not express what the product wants:
 *
 *   state        rules when they are confident, otherwise Jev
 *   importance   Jev
 *   urgency      Jev
 *   replyable    the user's own mark, then the machine-mail marker, then Jev
 *   topic        an LLM (prose)
 *   intent       the user — never written by a model
 *
 * So it is a small pipeline of three stages rather than one interface:
 *
 *   1. `RuleClassifier`    — deterministic, keyless, always runs
 *   2. `DecisionModel`     — Jev, typed decisions
 *   3. `ContextUpdater`    — an LLM, prose and context
 *
 * A keyless install just uses the rule-based defaults below. `decideConversation`
 * runs the stages in order and folds the result into one `Decision`.
 *
 * Jev and the LLM are deliberately separate seams. Jev returns decisions, not
 * text; the LLM writes text, not decisions. They are not swaps for each other.
 */

import type { Conversation, ConversationMessage } from './model.ts'
import type { ConversationState } from '#/db/schema.ts'
import type {
  ContactContextProposal,
  ContactDecisionContext,
} from '#/lib/contacts/context.ts'
import type { StateDefinitions } from '#/lib/organization/labels.ts'
import type { MeaningLabel } from '#/lib/organization/matching.ts'
import {
  activeImportanceOverride,
  activeStateOverride,
  deriveState,
} from './model.ts'

// Imported by path rather than through `#/lib/ai/index.ts`: the index pulls in
// Jev, the providers and the settings table, and this file must not drag the
// database into anything that imports the pipeline. `ai-log.ts` itself imports
// nothing but `node:fs`.
import { reportAiFailure } from '#/lib/ai/ai-log.ts'
import { isAutomatedThread } from './automated.ts'

export type DecisionInput = {
  subject: string
  /** Newest last. */
  messages: ConversationMessage[]
  ownerEmail: string
  /** The user's own goal for this conversation, when they have set one. */
  goal: string | null
  /** Last time the decision layer ran, if ever. */
  decidedAt: Date | null
  /**
   * The user has filed away mail from this thread's other party before, and has
   * not brought any of it back since.
   *
   * The one *learned* input: it comes from what the user did to other threads
   * from the same sender, not from anything in this one. Absent means nothing
   * has been learned — which is also what a thread with no other party has.
   */
  ignoredSender?: boolean
  /**
   * The user has marked this thread's other party as one they cannot reply to.
   *
   * The second *stored* input, and the authoritative one for replyability: the
   * machine-mail marker only catches senders that say so in their address, and
   * Jev can only guess from the writing. A company whose mail is view-only from
   * an ordinary address is invisible to both, and the user is the only one who
   * knows. Absent means nothing has been marked, which is also what a thread with
   * no other party has.
   */
  unreplyableSender?: boolean
  /** User's own 1–10 importance rating for this correspondent, if set. */
  senderImportance?: number | null
  /** User-authored profile notes for this correspondent, when present. */
  senderContext?: ContactDecisionContext | null
  /**
   * The tags already on this correspondent — the user's and the app's.
   *
   * Read once per sync batch and passed in so a refresh can reuse a spelling the
   * user chose instead of inventing a near-duplicate, and so the prompt sees how
   * the person is already filed. Only the app's own tags may be revised.
   */
  senderTags?: ReadonlyArray<string> | null
  /**
   * Earlier threads with the same correspondent, newest first.
   *
   * A profile that only ever sees the open thread re-learns the relationship
   * from one message at a time. These are the other conversations the caller
   * found by address, and they are evidence rather than instructions: the open
   * thread and anything the user wrote still win.
   */
  senderHistory?: ReadonlyArray<{
    providerThreadId: string
    subject: string
    messages: ReadonlyArray<{
      sender: string
      sentAt: string
      body: string
    }>
  }> | null
  /**
   * The user's own words for what a state means, where they rewrote one.
   *
   * The one place a classification can be personal: the rules and Jev both read
   * "needs action" the same way for everyone, and that is the label users
differ on most. Only customised labels arrive here — see
   * `customStateMeanings` — so an install that never edited a label sends
   * exactly what it sent before.
   */
  stateDefinitions?: StateDefinitions | null
  /**
   * Machine mail, where a refreshed profile would be noise rather than context.
   *
   * A verification code must not become the correspondent's `currentWork`, so the
   * stage still labels the thread but proposes no goal and no profile. The stored
   * `is_automated` flag is the caller's to pass: it is derived from the messages
   * before the rules run, so nothing has to guess here.
   */
  skipContextRefresh?: boolean
  /**
   * The user's own labels that have no match rule, so something has to read the
   * mail to place a thread in one.
   *
   * Only those: a label with a rule is settled by the rule, and the model is not
   * asked about it. Empty means the user has no meaning-matched labels, which is
   * the case for most installs.
   */
  meaningLabels?: MeaningLabel[] | null
}

/**
 * What the deterministic rules know.
 *
 * `state` is `null` when the rules have no strong signal — that is the gap the
 * decision model fills. The placeholder scores are what a keyless install falls
 * back to; a real model overrides them.
 */
export type RuleFacts = {
  /**
   * The deterministic state, or `null` when the rules have no strong signal.
   *
   * `low-priority` is a claim the rules can make on their own — machine mail and
   * broadcasts are settled without asking a model.
   */
  state: ConversationState | null
  awaitingReply: boolean
  requiresReply: boolean
  /**
   * There is no human on the other side — every message came from the owner or a
   * marked no-reply sender. Replyability's first, deterministic step, and the
   * signal that tells the decision model to leave the question alone.
   */
  isAutomated: boolean
  /**
   * The user has marked this sender as one a reply cannot reach.
   *
   * Settles replyability before the model is asked, the same way `isAutomated`
   * does — the two differ only in who decided, and in that this one is a stored
   * answer rather than something read off the address.
   */
  senderUnreplyable: boolean
  placeholderImportance: number
  placeholderUrgency: number
  reasoning: string
}

/** Stage 1 — deterministic and keyless. Always runs, and wins where it is sure. */
export interface RuleClassifier {
  readonly name: string
  classify: (input: DecisionInput) => RuleFacts
}

/** What the decision model (Jev) contributes. */
export type ModelVerdict = {
  /**
   * Used when the rules returned `null`, and also to *confirm or drop* a rule's
   * `needs-action` — a rule claiming something needs doing is the claim most
   * worth a second opinion, because a false positive is filed as work.
   *
   * Never applied to `waiting-for-reply` or `low-priority`: those the rules can
   * read off the message flow. `null` means "no opinion", and the rule stands.
   */
  state: ConversationState | null
  importance: number
  urgency: number
  /**
   * `null` means "no opinion" — the rule outcome stands. Only asked when the
   * thread has a human on it; machine mail is settled before the model sees it.
   */
  replyable: boolean | null
  /**
   * The id of one of the user's own meaning-matched labels, or null for none.
   *
   * Ids rather than names, because a rename has to move every thread with it.
   * Only ever an id the caller offered, so a model cannot invent a label.
   */
  labelId: string | null
  reasoning: string | null
}

/** Stage 2 — typed decisions. Jev, or the rule-based placeholder. */
export interface DecisionModel {
  readonly name: string
  decide: (input: DecisionInput, facts: RuleFacts) => Promise<ModelVerdict>
}

/**
 * What one context refresh produced.
 *
 * Three optional answers rather than a shape to copy over: a thread that says
 * nothing new about its correspondent returns the topic alone, and an empty
 * field means "nothing to change" — never "clear it". A model that returns
 * nothing at all returns `null` at the caller.
 */
export type ContextUpdate = {
  topic: string | null
  goal: string | null
  contact: ContactContextProposal | null
  /**
   * The id of one of the user's meaning-matched labels, or null for none.
   *
   * The same answer the decision model gives, asked here because which section a
   * thread belongs in is a judgement about prose — so an LLM is a fair second
   * opinion, and on an install with no Jev key it is the only one available.
   * Jev's typed answer wins where both are configured; see `decideConversation`.
   */
  labelId?: string | null
}

/**
 * Stage 3 — prose. An LLM labels the thread and refreshes what the app knows
 * about it.
 *
 * One prompt rather than three. The topic label already ran on every decide and
 * its answer was thrown away whenever a topic existed, so the same call now
 * returns the goal and the contact fields when the user has asked for them —
 * one call whether it is labelling a topic or refreshing a profile. A user who
 * has not opted in sends the label-only prompt they sent before, for the same
 * budget.
 *
 * Nothing this returns is written by `applyDecision`; see `applyDecision`'s note.
 */
export interface ContextUpdater {
  readonly name: string
  /**
   * True when this updater actually refreshes the profile.
   *
   * Lets the caller skip loading cross-thread history for an install that only
   * labels topics, where the evidence could never be used.
   */
  readonly refreshesProfiles?: boolean
  update: (input: DecisionInput) => Promise<ContextUpdate | null>
}

/** The composed result, in the order the app consumes it. */
export type Decision = {
  /**
   * `low-priority` is reachable from the rules (machine mail, promotions) and
   * from the model's scores. See `HeuristicRuleClassifier` and `foldState`.
   */
  state: ConversationState
  awaitingReply: boolean
  requiresReply: boolean
  /** False hides the composer and shows the "No reply" tag. */
  replyable: boolean
  importance: number
  urgency: number
  /** Topic is an LLM's job; null until one is configured. */
  topic: string | null
  /**
   * A goal the context stage proposes, or null when it proposed none.
   *
   * Deliberately not folded into `applyDecision`, which is what keeps the goal
   * user-owned: the thing that writes it is an explicit, revisioned call behind
   * the user's own switch.
   */
  goal: string | null
  /** Contact profile fields the context stage proposes, or null for none. */
  contact: ContactContextProposal | null
  /**
   * A custom label the decision settled the thread into, or null for none.
   *
   * Not applied by `applyDecision`: the write goes through the revision log, and
   * only for a thread the user has not filed by hand.
   */
  labelId: string | null
  reasoning: string | null
  /** Stage names that ran, in order. Recorded on the `decisions` row. */
  providers: string[]
}

export type DecisionPipeline = {
  rules: RuleClassifier
  model: DecisionModel
  context: ContextUpdater
}

/**
 * Deterministic rules, wrapping `deriveState`.
 *
 * `informational` is the rules' "no strong signal" bucket, so it is reported as
 * `null` rather than claimed: the decision model is allowed to say something
 * sharper about a thread the rules could only shrug at.
 */
export class HeuristicRuleClassifier implements RuleClassifier {
  readonly name = 'rules'

  classify(input: DecisionInput): RuleFacts {
    const last = input.messages.at(-1)

    const result = deriveState(input.messages, {
      ownerEmail: input.ownerEmail,
      lastMessageAt: last?.sentAt ?? new Date(0),
      now: new Date(),
    })

    const isAutomated = isAutomatedThread(input.messages, input.ownerEmail)

    // The user's own mark on this sender. Read here rather than in the fold so
    // the model's replyability question can be skipped entirely: the user has
    // already answered it, and asking would only invite the model to disagree.
    const senderUnreplyable = input.unreplyableSender === true

    // What the user has taught the app about this sender, applied to a thread
    // they have never answered: mail arriving in one direction only, with
    // nobody asking them anything.
    //
    // The case this exists for is the one-off notice — "your order shipped",
    // "someone viewed your profile" — which is not machine-marked often enough
    // for the marker to catch it, and which nobody wants to be told about
    // twice. A question survives it: if there is something to answer, the
    // thread is work again whatever the sender's history is.
    const learnedLowPriority =
      input.ignoredSender === true &&
      input.messages.every((message) => !message.isFromOwner) &&
      !result.requiresReply

    // Three deterministic routes into `low-priority`, all keyless:
    //
    // - Machine mail is not a conversation. Nothing is expected of the reader and
    //   the thread is never replyable, so "a receipt landed" is not work.
    // - A broadcast promotion is not addressed to the reader either. Its "?" is a
    //   call to action ("Do you want to save 20%?"), and that is what used to file
    //   marketing mail under Needs action.
    // - A sender the user has already filed away, writing a one-way notice. This
    //   is the app applying their own earlier judgement, so that the same mail
    //   only has to be dismissed once to stop coming back.
    //
    // None of them asks the model: the rules can justify all three, and the cost
    // of being wrong is low — the thread is still listed, still readable, still
    // replyable when a human wrote it.
    const lowPriority =
      isAutomated ||
      (result.state !== 'waiting-for-reply' && result.intent === 'promotion') ||
      learnedLowPriority

    // `informational` is the rules' "no strong signal" bucket, so it is reported
    // as `null` rather than claimed: the model is allowed to say something
    // sharper about a thread the rules could only shrug at.
    const state: ConversationState | null = lowPriority
      ? 'low-priority'
      : result.state === 'informational'
        ? null
        : result.state

    const reasoning = !last
      ? 'Empty conversation.'
      : lowPriority
        ? isAutomated
          ? 'Machine mail; nothing here is written to you.'
          : learnedLowPriority
            ? 'You have filed away mail from this sender before.'
            : 'A bulk promotion; nobody is asking you for anything.'
        : last.isFromOwner
          ? 'You sent the last message; waiting on a reply.'
          : result.requiresReply
            ? 'The last message asks you a direct question.'
            : 'Last message was informational.'

    return {
      state,
      awaitingReply: result.awaitingReply,
      requiresReply: result.requiresReply,
      isAutomated,
      senderUnreplyable,
      placeholderImportance: result.importance,
      placeholderUrgency: result.urgency,
      reasoning,
    }
  }
}

/**
 * Keyless fallback for the decision model.
 *
 * Returns the rule placeholders and never claims a state of its own. Exists so
 * the pipeline is whole before Jev is wired in, and so an install with no Jev key
 * still behaves exactly as it does today.
 */
export class PlaceholderDecisionModel implements DecisionModel {
  readonly name = 'rules'

  async decide(_input: DecisionInput, facts: RuleFacts): Promise<ModelVerdict> {
    return {
      state: null,
      importance: facts.placeholderImportance,
      urgency: facts.placeholderUrgency,
      replyable: null,
      labelId: null,
      reasoning: null,
    }
  }
}

/** Keyless fallback for the context stage: no topic, no update. */
export class NoContextUpdater implements ContextUpdater {
  readonly name = 'none'

  async update(): Promise<ContextUpdate | null> {
    return null
  }
}

/** The all-rules pipeline used when no AI service is configured. */
export function defaultDecisionPipeline(): DecisionPipeline {
  return {
    rules: new HeuristicRuleClassifier(),
    model: new PlaceholderDecisionModel(),
    context: new NoContextUpdater(),
  }
}

/**
 * Run the pipeline and fold the stages into one decision.
 *
 * The rules decide the state when they are confident; otherwise the decision
 * model does. Importance/urgency come from the model (the placeholders when there
 * is none). Topic comes from the generator. `intent` is deliberately absent — it
 * is the user's to set.
 */
export async function decideConversation(
  input: DecisionInput,
  pipeline: DecisionPipeline = defaultDecisionPipeline(),
): Promise<Decision> {
  const facts = pipeline.rules.classify(input)

  // The AI stages are optional and independently configured, so a failure in
  // either must degrade to the deterministic answer rather than reject. The
  // callers persist the conversation around this call (`decideAndSave`), so a
  // provider that is down, rate limited, or misconfigured (a stale model name,
  // a rejected parameter) must not stop a synced thread from being saved —
  // otherwise the inbox silently stops showing new mail.
  const verdict = await safeDecide(pipeline.model, input, facts)
  const context = await safeUpdateContext(pipeline.context, input)

  return {
    state: foldState(facts, verdict),
    awaitingReply: facts.awaitingReply,
    requiresReply: facts.requiresReply,
    // Machine mail is settled by the marker and cannot be talked back into being
    // replyable; otherwise the model may downgrade it, and defaults to yes. The
    // user's own mark settles it too, and for the same reason — it is an answer
    // rather than a hint, and a re-decide must not reach a different one.
    replyable:
      facts.isAutomated || facts.senderUnreplyable
        ? false
        : (verdict.replyable ?? true),
    importance: verdict.importance,
    urgency: verdict.urgency,
    topic: context?.topic ?? null,
    goal: context?.goal ?? null,
    contact: context?.contact ?? null,
    // The typed decision first, then prose: Jev answers with a calibrated choice
    // and the LLM with a reading of the description, and a keyless-Jev install
    // otherwise has nobody to ask at all.
    labelId: verdict.labelId ?? context?.labelId ?? null,
    reasoning: verdict.reasoning ?? facts.reasoning,
    providers: [
      pipeline.rules.name,
      pipeline.model.name,
      pipeline.context.name,
    ],
  }
}

/**
 * Fold the rule facts and the model verdict into one state.
 *
 * Three cases, in order:
 *
 * 1. The rules are certain (`waiting-for-reply`, `low-priority`) — the answer is
 *    readable from the message flow, so nothing overrides it.
 * 2. Otherwise — the rules abstained, or claimed `needs-action` — the model's
 *    answer wins when it gave one. A rule can only ever *add* work, and "a `?`
 *    in the body" is a weaker signal than a model reading the thread, so the
 *    false positives it produces are exactly the threads worth a second
 *    opinion. A `null` verdict (no model, no answer) keeps the rule.
 *
 * An `informational` verdict still needs nothing, so when the model *also* scored
 * both importance and urgency at the bottom of its rubric the thread is moved to
 * `low-priority` — "nothing to do" and "not worth your time now" are different
 * answers, and only the second one keeps the inbox quiet.
 */
function foldState(facts: RuleFacts, verdict: ModelVerdict): ConversationState {
  if (facts.state === 'waiting-for-reply' || facts.state === 'low-priority') {
    return facts.state
  }

  const state = verdict.state ?? facts.state ?? 'informational'
  if (state !== 'informational') return state

  return isTrivial(verdict) ? 'low-priority' : 'informational'
}

/** The model's own scores say the thread is barely worth opening. */
function isTrivial(verdict: ModelVerdict): boolean {
  return verdict.importance <= 3 && verdict.urgency <= 3
}

/** Run the decision model, falling back to the rule placeholders on failure. */
async function safeDecide(
  model: DecisionModel,
  input: DecisionInput,
  facts: RuleFacts,
): Promise<ModelVerdict> {
  try {
    return await model.decide(input, facts)
  } catch (error) {
    // Logged to the file as well as the terminal: a failure the rules paper over
    // is exactly the one nobody notices until they ask why nothing happened.
    await reportAiFailure(
      model.name,
      error,
      'failed; using rules for this conversation',
    )
    return {
      state: null,
      importance: facts.placeholderImportance,
      urgency: facts.placeholderUrgency,
      replyable: null,
      labelId: null,
      reasoning: null,
    }
  }
}

/**
 * Run the context stage, or null when it fails.
 *
 * A failure costs the label and the refresh, never the decision: the stored goal
 * and profile stay exactly as they were, which is the same rule the decision
 * model follows.
 */
async function safeUpdateContext(
  context: ContextUpdater,
  input: DecisionInput,
): Promise<ContextUpdate | null> {
  try {
    return await context.update(input)
  } catch (error) {
    await reportAiFailure(
      context.name,
      error,
      'failed; this conversation gets no topic and no context update',
    )
    return null
  }
}

/**
 * Apply a decision to a conversation.
 *
 * `goal` and `intent` are user-owned and are never written here — the user is the
 * source of truth for what a thread means to them, and a decision layer has no
 * business overwriting either.
 *
 * `state` joins them in that respect: the user's own call outranks the pipeline,
 * which is the whole point of storing it. A call the thread has outrun is dropped
 * rather than kept — it no longer affects the state, and leaving it on the row
 * would make an expired judgement look current to the next reader.
 */
export function applyDecision(
  conversation: Conversation,
  decision: Decision,
): Conversation {
  const override = activeStateOverride(conversation)
  // The score is the user's for the same reason, and it is cleared on the same
  // terms: one the thread has outrun is dropped rather than left on the row, so
  // the next reader cannot mistake an expired judgement for a current one.
  const importanceOverride = activeImportanceOverride(conversation)

  return {
    ...conversation,
    state: override ?? decision.state,
    stateOverride: override ? conversation.stateOverride : null,
    awaitingReply: decision.awaitingReply,
    replyable: decision.replyable,
    importance: importanceOverride ?? decision.importance,
    importanceOverride:
      importanceOverride === null ? null : conversation.importanceOverride,
    urgency: decision.urgency,
    requiresReply: decision.requiresReply,
    // Only fill the topic if the user has not set one.
    topic: conversation.topic ?? decision.topic,
  }
}
