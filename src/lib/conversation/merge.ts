/**
 * Merging several connected mailboxes into one inbox.
 *
 * Accounts are global to the install, so the list the user sees is the union of
 * every account's conversations. Two things make that more than a `concat`:
 *
 * 1. **The same thread can exist in more than one mailbox.** If both of your
 *    addresses are on a thread, Gmail stores it twice — two thread ids,
 *    overlapping messages. `internetMessageId` is the RFC 5322 `Message-ID`,
 *    which is the same string in every mailbox that received that message, so
 *    clustering on it is exact rather than a subject/participant guess.
 *
 *    A provider that gives the message no usable Message-ID (Outlook falls back
 *    to its own id when the header is missing, for example) would otherwise
 *    leave two copies looking like two threads. For those, a conservative
 *    fallback matches the *first* message: the normalised subject, its sender
 *    and time, and the exact set of senders in the thread. Later replies can be
 *    missing from one copy; the message that started the thread cannot.
 *
 * 2. **What the thread means depends on how your accounts relate to it.** A
 *    thread you correspond on is not the same as one you merely receive a copy
 *    of. That relation decides which account owns the row, whether a passive copy
 *    may drive its state, and which address a reply should leave from.
 *
 * The merge happens at the *message* level and rebuilds the conversation once,
 * rather than folding two built conversations together: `state`, `participants`
 * and the counts all depend on the ordered union of messages, and re-deriving
 * them from a half-merged pair is how a thread ends up claiming it was you who
 * spoke last.
 */

import type {
  Conversation,
  ConversationAttachment,
  ConversationMessage,
} from './model.ts'
import {
  activeDone,
  activeImportanceOverride,
  activeStateOverride,
  dedupeParticipants,
  deriveState,
  normaliseEmail,
} from './model.ts'
import { isAutomatedThread } from './automated.ts'
import type { ConversationState } from '#/db/schema.ts'

/** A connected mailbox, as the inbox knows it. */
export type ConnectedAccount = {
  id: string
  email: string
}

/** One account's view of a conversation, before merging. */
export type AccountConversation = {
  accountId: string
  conversation: Conversation
}

/**
 * How the connected accounts stand relative to one thread.
 *
 * - `between-your-accounts` — two or more of your addresses are correspondents
 *   (in `From`/`To`), including the case where one of your addresses wrote to
 *   another.
 * - `primary` — exactly one of your addresses is a correspondent; the rest only
 *   ever appear in `Cc`.
 * - `cc-only` — none of your addresses is a correspondent; you are copied in.
 */
export type MergeRelation = 'between-your-accounts' | 'primary' | 'cc-only'

export type MergedConversation = {
  /** Stable id — the owning account's conversation id. */
  id: string
  /** The account the row belongs to: drives replies, profiles and details edits. */
  ownerAccountId: string
  relation: MergeRelation
  /** Every account whose mailbox holds this thread, in input order. */
  sourceAccountIds: string[]
  /** Accounts that hold it only as a passive copy. Annotation, never state. */
  ccAccountIds: string[]
  /**
   * Which account a reply could leave from, best first.
   *
   * `[0]` is the default; the composer shows it and lets the user pick when the
   * thread carries more than one of their addresses.
   */
  replyAccountIds: string[]
  /** One conversation, rebuilt from the union of messages. */
  conversation: Conversation
}

/** An address to account lookup, normalised once for the whole merge. */
function accountIndex(accounts: ConnectedAccount[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const account of accounts) {
    index.set(normaliseEmail(account.email), account.id)
  }
  return index
}

/** Which of my accounts are correspondents, and which only get a copy. */
function rolesFor(
  messages: Array<Pick<ConversationMessage, 'from' | 'to' | 'cc'>>,
  accountsByEmail: Map<string, string>,
): { direct: string[]; cc: string[] } {
  const direct = new Set<string>()
  const cc = new Set<string>()

  for (const message of messages) {
    // `From` and `To` are both "a correspondent": a thread you started counts
    // the same as one you were addressed on.
    for (const participant of [message.from, ...message.to]) {
      const id = accountsByEmail.get(normaliseEmail(participant.email))
      if (id) direct.add(id)
    }
    for (const participant of message.cc) {
      const id = accountsByEmail.get(normaliseEmail(participant.email))
      if (id) cc.add(id)
    }
  }

  // A direct sighting anywhere outranks a CC one anywhere.
  for (const id of direct) cc.delete(id)

  return { direct: [...direct], cc: [...cc] }
}

/** Classify a thread from roles already resolved. */
export function relationForRoles(roles: {
  direct: string[]
  cc: string[]
}): MergeRelation {
  if (roles.direct.length >= 2) return 'between-your-accounts'
  if (roles.direct.length === 1) return 'primary'
  return 'cc-only'
}

/**
 * Which of the user's accounts a reply could leave from, owner first.
 *
 * Used by the conversation view, which holds one thread rather than a cluster.
 */
export function replyAccountsFor(
  messages: Array<Pick<ConversationMessage, 'from' | 'to' | 'cc'>>,
  accounts: ConnectedAccount[],
  ownerAccountId: string,
): string[] {
  const { direct, cc } = rolesFor(messages, accountIndex(accounts))
  return [
    ownerAccountId,
    ...[...direct, ...cc].filter((id) => id !== ownerAccountId),
  ].filter((id) => id !== '')
}

/** Classify a thread's relation from its messages. Exported for tests. */
export function relationOf(
  messages: Array<Pick<ConversationMessage, 'from' | 'to' | 'cc'>>,
  accounts: ConnectedAccount[],
): MergeRelation {
  return relationForRoles(rolesFor(messages, accountIndex(accounts)))
}

/**
 * Strip the prefixes a provider adds to every reply in a thread.
 *
 * Gmail and Graph both keep the original subject on the thread but prefix the
 * individual messages; the stored thread subject can come from either. Removing
 * `Re:`, `Fwd:` and their common localised forms is what lets the fallback
 * compare "Invoice" with "Re: Invoice" without also treating two genuinely
 * different subjects as equal.
 */
const SUBJECT_PREFIX = /^(?:re|fw|fwd|aw|sv)\s*(?:\[\d+\])?\s*:\s*/i

/** Did this subject come from a client's Reply/Forward action? */
export function hasReplyPrefix(subject: string): boolean {
  return SUBJECT_PREFIX.test(subject.trim())
}

export function normaliseThreadSubject(subject: string): string {
  let value = subject.trim()
  while (SUBJECT_PREFIX.test(value)) {
    value = value.replace(SUBJECT_PREFIX, '').trim()
  }
  return value.replace(/\s+/g, ' ').toLowerCase()
}

/**
 * What "the same conversation" looks like when no Message-ID is shared.
 *
 * Most copies are already joined exactly by `internetMessageId`. The fallback is
 * for the rest: a provider that drops the header, a synthetic provider id, a
 * thread whose messages were stored before the header was read. It deliberately
 * looks at the *first* message rather than the newest one — later replies can
 * arrive in one mailbox and not the other, but the message that started the
 * thread is the same mail in both.
 */
export type ThreadIdentity = {
  /** Normalised subject, with reply/forward prefixes removed. */
  subject: string
  /** True when the stored subject still has a Re:/Fwd: prefix. */
  subjectIsReply: boolean
  firstFrom: string
  /** Everyone the oldest message was addressed to (To and Cc). */
  firstRecipients: string[]
  /** Sent time of the oldest message, in milliseconds. */
  firstAt: number
  /** RFC `Message-ID` of the oldest message, when the provider gave one. */
  firstMessageId: string | null
  /** Every distinct `From` address in the thread, sorted. */
  senders: string[]
}

/**
 * How far apart two copies' first messages may be and still be called the same.
 *
 * The Date header is identical in both deliveries, so the real value is usually
 * exactly equal. The window only absorbs a provider that drops seconds or
 * round-trips the date through a different format.
 */
export const THREAD_IDENTITY_WINDOW_MS = 2 * 60 * 1000

/** The identity facts for one stored conversation, or null when too little is known. */
export function threadIdentity(
  conversation: Conversation,
): ThreadIdentity | null {
  if (conversation.messages.length === 0) return null

  const first = conversation.messages.reduce((earliest, message) =>
    message.sentAt < earliest.sentAt ? message : earliest,
  )
  const firstAt = first.sentAt.getTime()
  const rawSubject = conversation.subject.trim() || first.subject
  const subject = normaliseThreadSubject(rawSubject)
  const firstFrom = normaliseEmail(first.from.email)
  const firstRecipients = [
    ...new Set(
      [...first.to, ...first.cc]
        .map((participant) => normaliseEmail(participant.email))
        .filter((email) => email !== ''),
    ),
  ].sort()

  // Without a subject, a sender and a real time there is nothing safe to compare:
  // every empty-subject notification would look like every other one.
  if (!subject || !firstFrom || !Number.isFinite(firstAt)) return null

  const senders = [
    ...new Set(
      conversation.messages
        .map((message) => normaliseEmail(message.from.email))
        .filter((email) => email !== ''),
    ),
  ].sort()

  return {
    subject,
    subjectIsReply: hasReplyPrefix(rawSubject) || hasReplyPrefix(first.subject),
    firstFrom,
    firstRecipients,
    firstAt,
    firstMessageId: first.internetMessageId,
    senders,
  }
}

/** Only an RFC 5322 Message-ID is globally shared; provider ids are not. */
function isRfcMessageId(value: string | null): value is string {
  return value !== null && /^<[^<>\s]+@[^<>\s]+>$/.test(value)
}

/** How long after the original a reply may still be the same thread. */
export const REPLY_LINK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Does this reply belong to that conversation, even without a stored header?
 *
 * The case this exists for: one mail goes to several people, one replies, and
 * the provider files the reply under a thread id of its own. `In-Reply-To` is
 * the exact link and is stored on new mail. This is the same-mailbox fallback for
 * mail stored before those headers were kept, and for providers that omit them.
 *
 * Deliberately narrow: the reply must carry a reply/forward prefix, the parent
 * must not, the normalized subjects must agree, the reply must follow the parent
 * within a month, and the reply's sender must be someone the parent was actually
 * addressed to (or the parent's sender must be someone the reply addressed). A
 * recipient replying is a much stronger signal than one subject string.
 */
export function sameThreadReply(
  reply: ThreadIdentity,
  parent: ThreadIdentity,
): boolean {
  if (!reply.subjectIsReply || parent.subjectIsReply) return false
  if (reply.subject !== parent.subject) return false
  // Five minutes of clock slack covers a provider that stores received time on
  // one side and the Date header on the other.
  if (reply.firstAt + 5 * 60_000 < parent.firstAt) return false
  if (reply.firstAt - parent.firstAt > REPLY_LINK_WINDOW_MS) return false

  return (
    parent.firstRecipients.includes(reply.firstFrom) ||
    reply.firstRecipients.includes(parent.firstFrom)
  )
}

/**
 * Could these two rows be copies of one thread in different mailboxes?
 *
 * Conservative on purpose. A false positive merges two unrelated letters and —
 * because a merge carries the owner's folder — can hide one of them in Spam. So
 * every signal has to agree: the normalized subject, the sender of the first
 * message, the first message's time, the exact set of senders, and no evidence
 * that the two first messages are different (two real, different Message-IDs).
 */
export function sameThreadIdentity(
  a: ThreadIdentity | null,
  b: ThreadIdentity | null,
): boolean {
  if (!a || !b) return false
  if (a.subject !== b.subject) return false
  if (a.firstFrom !== b.firstFrom) return false
  if (Math.abs(a.firstAt - b.firstAt) > THREAD_IDENTITY_WINDOW_MS) {
    return false
  }

  if (
    isRfcMessageId(a.firstMessageId) &&
    isRfcMessageId(b.firstMessageId) &&
    a.firstMessageId !== b.firstMessageId
  ) {
    return false
  }

  return (
    a.senders.length === b.senders.length &&
    a.senders.every((sender, index) => sender === b.senders[index])
  )
}

/** Dedupe key for a message, mirroring the parser's own identity for it. */
function messageKey(accountId: string, message: ConversationMessage): string {
  return (
    message.internetMessageId ?? `${accountId}:${message.providerMessageId}`
  )
}

/**
 * The ids a message says it answers, with RFC angle brackets removed.
 *
 * `In-Reply-To` is the direct parent and `References` is the whole chain. A
 * provider can split a reply into a different thread while still carrying these
 * headers, so they are the only evidence that the new thread is the old one.
 */
export function replyReferenceIds(
  message: Pick<ConversationMessage, 'inReplyTo' | 'references'>,
): string[] {
  const ids = message.inReplyTo ? [message.inReplyTo] : []
  for (const id of message.references ?? []) ids.push(id)
  return ids.map((id) => id.trim().replace(/^</, '').replace(/>$/, ''))
}

/**
 * Dedupe key for a non-media attachment that survives a copy between mailboxes.
 *
 * Media is returned without a metadata key and left for byte-hash deduplication
 * in the detail view. Non-media retains the prior metadata behavior.
 */
function attachmentKey(attachment: ConversationAttachment): string | null {
  const mimeType = attachment.mimeType.trim().toLowerCase()
  // Metadata cannot prove two media files are identical: the same image can be
  // renamed, and two distinct images can share a name and byte size. Leave media
  // for the detail view's content-hash dedupe instead.
  if (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('video/')
  ) {
    // Keep full media rows so content can be hashed and a working source URL can
    // be chosen for each copy in the detail view.
    return null
  }
  return `${attachment.filename}|${attachment.sizeBytes}|${attachment.contentId ?? ''}`
}

/**
 * Merge every account's conversations into one list.
 *
 * Pure: takes already-loaded conversations and returns merged ones, so it can be
 * tested without a database and reused by the inbox loader.
 */
export function mergeAccountConversations(
  sources: AccountConversation[],
  accounts: ConnectedAccount[],
): MergedConversation[] {
  const accountsByEmail = accountIndex(accounts)
  const ownerEmails = [...accountsByEmail.keys()]

  // Union-find over source indices, joined by any shared Message-ID.
  const parent = sources.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root] ?? root
    // Path compression, so a long quoted chain does not rescan every lookup.
    let walk = index
    while (parent[walk] !== root) {
      const next = parent[walk] ?? root
      parent[walk] = root
      walk = next
    }
    return root
  }
  const union = (a: number, b: number): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent[rootB] = rootA
  }

  const firstSeen = new Map<string, number>()
  sources.forEach((source, index) => {
    for (const message of source.conversation.messages) {
      // Only a real Message-ID can be shared across mailboxes. A message without
      // one (a synthetic id) stays in its own cluster.
      if (!message.internetMessageId) continue

      const seen = firstSeen.get(message.internetMessageId)
      if (seen === undefined) firstSeen.set(message.internetMessageId, index)
      else union(seen, index)
    }
  })

  // A reply belongs to the thread of the message it answers even when the
  // provider gave it a thread id of its own. Without this pass a reply from one
  // of several recipients on a mail we sent could arrive as a separate row: its
  // Message-ID is new, and only `In-Reply-To` names the sent message.
  sources.forEach((source, index) => {
    for (const message of source.conversation.messages) {
      for (const reference of replyReferenceIds(message)) {
        const parentIndex = firstSeen.get(reference)
        if (parentIndex !== undefined) union(parentIndex, index)
      }
    }
  })

  // The exact pass above misses copies from a provider that did not give the
  // message an RFC Message-ID. Match those by identity instead, but only across
  // different accounts: two same-account threads with one subject are two
  // threads, not two copies.
  const identities = sources.map((source) =>
    threadIdentity(source.conversation),
  )
  const identityBuckets = new Map<string, number[]>()
  identities.forEach((identity, index) => {
    if (!identity) return
    const key = `${identity.subject}\u0000${identity.firstFrom}`
    const bucket = identityBuckets.get(key)
    if (bucket) bucket.push(index)
    else identityBuckets.set(key, [index])
  })

  for (const indices of identityBuckets.values()) {
    for (let i = 0; i < indices.length; i += 1) {
      for (let j = i + 1; j < indices.length; j += 1) {
        const a = indices[i]
        const b = indices[j]
        if (sources[a].accountId === sources[b].accountId) continue
        if (sameThreadIdentity(identities[a], identities[b])) {
          union(a, b)
        }
      }
    }
  }

  // Same-mailbox replies that the provider stored as their own thread. This is
  // deliberately separate from the cross-account pass: there, identical subjects
  // are two copies; here, a `Re:` thread following the mail it answers is one
  // conversation. Requiring exactly one parent keeps an ambiguous subject from
  // folding unrelated threads together.
  const replyBuckets = new Map<string, number[]>()
  identities.forEach((identity, index) => {
    if (!identity) return
    const key = `${sources[index].accountId}\u0000${identity.subject}`
    const bucket = replyBuckets.get(key)
    if (bucket) bucket.push(index)
    else replyBuckets.set(key, [index])
  })

  for (const indices of replyBuckets.values()) {
    const parents = indices.filter(
      (index) => identities[index]?.subjectIsReply === false,
    )
    if (parents.length === 0) continue

    for (const replyIndex of indices) {
      const reply = identities[replyIndex]
      if (!reply?.subjectIsReply) continue

      const matches = parents.filter((parentIndex) => {
        const parentIdentity = identities[parentIndex]
        return parentIdentity ? sameThreadReply(reply, parentIdentity) : false
      })
      if (matches.length === 1) union(replyIndex, matches[0])
    }
  }

  const clusters = new Map<number, number[]>()
  sources.forEach((_, index) => {
    const root = find(index)
    const list = clusters.get(root)
    if (list) list.push(index)
    else clusters.set(root, [index])
  })

  const merged: MergedConversation[] = []
  for (const indices of clusters.values()) {
    const cluster = indices.map((index) => sources[index])
    if (cluster.length > 0) {
      merged.push(mergeCluster(cluster, accountsByEmail, ownerEmails))
    }
  }
  return merged
}

/** Merge one cluster of sources that all describe the same thread. */
function mergeCluster(
  cluster: AccountConversation[],
  accountsByEmail: Map<string, string>,
  ownerEmails: string[],
): MergedConversation {
  const allMessages = cluster.flatMap((source) => source.conversation.messages)
  const { direct: directAccounts, cc: ccAccounts } = rolesFor(
    allMessages,
    accountsByEmail,
  )
  const relation = relationForRoles({
    direct: directAccounts,
    cc: ccAccounts,
  })

  // The newest message decides the default sender: it is the account the ball
  // was last thrown to.
  const newest = allMessages.reduce<ConversationMessage | null>(
    (latest, message) =>
      !latest || message.sentAt > latest.sentAt ? message : latest,
    null,
  )
  const addressed = new Set<string>()
  for (const participant of [...(newest?.to ?? []), ...(newest?.cc ?? [])]) {
    const id = accountsByEmail.get(normaliseEmail(participant.email))
    if (id) addressed.add(id)
  }

  const ownerAccountId =
    [...addressed].find((id) => directAccounts.includes(id)) ??
    directAccounts.at(0) ??
    [...addressed].at(0) ??
    ccAccounts.at(0) ??
    cluster.at(0)?.accountId ??
    ''

  const rest =
    relation === 'cc-only' ? ccAccounts : [...directAccounts, ...ccAccounts]
  const replyAccountIds = [
    ownerAccountId,
    ...rest.filter((accountId) => accountId !== ownerAccountId),
  ].filter((accountId) => accountId !== '')

  const conversation = rebuildConversation(
    cluster,
    ownerAccountId,
    relation,
    ownerEmails,
  )

  return {
    id: conversation.id,
    ownerAccountId,
    relation,
    sourceAccountIds: cluster.map((source) => source.accountId),
    ccAccountIds: ccAccounts,
    replyAccountIds,
    conversation,
  }
}

/** Rebuild one conversation from the union of its mailboxes' messages. */
function rebuildConversation(
  cluster: AccountConversation[],
  ownerAccountId: string,
  relation: MergeRelation,
  ownerEmails: string[],
): Conversation {
  // When the owner's mailbox holds the thread as several fragments, pick the most
  // complete one as the canonical row. Order alone is not enough: the inbox and
  // the detail view can feed the same cluster in different orders, and an unstable
  // choice would make the row id — and the topic/goal stored against it — move.
  const ownerCandidates = cluster.filter(
    (source) => source.accountId === ownerAccountId,
  )
  const owner =
    [...ownerCandidates]
      .sort(
        (a, b) =>
          b.conversation.messages.length - a.conversation.messages.length ||
          a.conversation.providerThreadId.localeCompare(
            b.conversation.providerThreadId,
          ),
      )
      .at(0) ?? cluster.at(0)
  if (!owner) {
    // Unreachable: `mergeCluster` is only called with a non-empty cluster.
    throw new Error('Cannot rebuild a conversation from an empty cluster')
  }

  // The owner's copy is read first so that, where both mailboxes hold the same
  // message, the body parsed under the owner's own sender profile wins.
  const ordered = [
    ...cluster.filter((source) => source.accountId === ownerAccountId),
    ...cluster.filter((source) => source.accountId !== ownerAccountId),
  ]

  const seen = new Set<string>()
  const union: ConversationMessage[] = []
  for (const source of ordered) {
    for (const message of source.conversation.messages) {
      const key = messageKey(source.accountId, message)
      if (seen.has(key)) continue
      seen.add(key)
      union.push(message)
    }
  }
  union.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())

  const owners = new Set(ownerEmails.map(normaliseEmail))
  const messages = union.map((message) => ({
    ...message,
    // "Mine" is the set of connected addresses, not the owning account alone.
    isFromOwner: owners.has(normaliseEmail(message.from.email)),
  }))

  const attachments = dedupeAttachments(
    cluster.flatMap((source) =>
      source.conversation.attachments.map((attachment) => ({
        ...attachment,
        providerThreadId: source.conversation.providerThreadId,
      })),
    ),
  )
  const participants = dedupeParticipants(
    messages.flatMap((message) => [message.from, ...message.to, ...message.cc]),
  )

  const lastMessageAt =
    messages.at(-1)?.sentAt ?? owner.conversation.lastMessageAt
  const decision = deriveState(messages, {
    ownerEmail: ownerAccountId,
    lastMessageAt,
    now: new Date(),
  })

  // A CC-only thread is someone else's conversation you happen to be copied on
  // twice, so it is ranked low and never claims to need a reply.
  const ccOnly = relation === 'cc-only'

  // Rebuilt from the union, so the deterministic replyability marker is
  // recomputed the same way `isAutomated` is. The model is not re-run here (that
  // needs the pipeline, which is async and configured elsewhere), so `decided`
  // below is where a merged thread's state, importance and urgency come from.
  const rebuiltIsAutomated = isAutomatedThread(messages, ownerEmails)

  // With nothing to merge — one mailbox holding the thread, and the connected
  // set not changing who "mine" is — the stored derived fields are kept as they
  // are. That matters because the decision layer writes them: re-deriving here
  // would quietly discard its output, and would also override a column that a
  // version bump has deliberately left alone. Only an actual merge, or a second
  // address of the user's appearing on the thread, needs the recomputation.
  const ownershipChanged = messages.some(
    (message, index) => message.isFromOwner !== union[index].isFromOwner,
  )
  const stored = owner.conversation

  // The decision layer's output (state, importance, urgency) lives on the row it
  // was written to, so a merge reuses it instead of re-deriving it with
  // `deriveState` — which is the *rules*, and using it here threw away whatever
  // Jev had answered. The row holding the cluster's newest message is the one
  // whose thread looks like the merged view.
  const decided = cluster.reduce((best, source) => {
    const sourceAt = source.conversation.lastMessageAt.getTime()
    const bestAt = best.conversation.lastMessageAt.getTime()
    if (sourceAt > bestAt) return source
    // A tie is the common case — both mailboxes hold the same newest message —
    // and the owner's own row is the one replies and details edits point at.
    if (sourceAt === bestAt && source.accountId === ownerAccountId)
      return source
    return best
  }, owner).conversation

  // A certain rule still outranks the stored answer: if the union says we spoke
  // last, the row's older `needs-action` cannot stand. An `informational` union
  // says nothing the stored decision did not already account for, so the model's
  // verdict is kept there.
  const flowedState =
    decision.state === 'needs-action' || decision.state === 'waiting-for-reply'
      ? decision.state
      : decided.state

  // The user's own call is the one thing a merge cannot overrule, and it is
  // re-checked against the *union's* newest message: a message from another
  // mailbox that the owning row never saw outruns the call just as one in the
  // same mailbox would, and the thread comes back for a fresh look.
  const override =
    decided.stateOverride &&
    activeStateOverride({
      stateOverride: decided.stateOverride,
      lastMessageAt,
    })

  // The user's score follows the same rule as their label: the union's newest
  // message is the clock, so a message from another mailbox that the owning row
  // never saw outruns the score too.
  const importanceOverride =
    decided.importanceOverride &&
    activeImportanceOverride({
      importanceOverride: decided.importanceOverride,
      lastMessageAt,
    }) !== null
      ? decided.importanceOverride
      : null

  // A no-reply verdict is carried for the same reason `state` and the scores are:
  // it came from the user's own mark on the sender, or from Jev reading the
  // thread, and the union is a second mailbox's copy of the same mail rather than
  // new evidence. Recomputing it here would put a reply box back on a thread the
  // user said cannot be answered.
  //
  // Machine mail is the exception, and `isAutomated` on the row is what tells the
  // two apart: that verdict *is* re-derived from the union, because
  // `isAutomatedThread` is designed to let a thread a human finally answers
  // become a conversation again.
  const decidedNoReply = decided.replyable === false && !decided.isAutomated

  const derived =
    cluster.length === 1 && !ownershipChanged
      ? {
          state: stored.state,
          awaitingReply: stored.awaitingReply,
          requiresReply: stored.requiresReply,
          importance: stored.importance,
          urgency: stored.urgency,
          intent: stored.intent,
          isAutomated: stored.isAutomated,
          replyable: stored.replyable,
        }
      : {
          state: flowedState,
          // The message-flow facts are re-read from the union: with a second
          // mailbox in play, who spoke last and whether a question is still
          // outstanding genuinely change, and those are the rules' own.
          awaitingReply: decision.awaitingReply,
          requiresReply: decision.requiresReply,
          intent: decision.intent,
          importance: decided.importance,
          urgency: decided.urgency,
          isAutomated: rebuiltIsAutomated,
          replyable: !rebuiltIsAutomated,
        }

  const topic =
    owner.conversation.topic ??
    cluster.find((source) => source.conversation.topic)?.conversation.topic ??
    null
  const goal =
    owner.conversation.goal ??
    cluster.find((source) => source.conversation.goal)?.conversation.goal ??
    null

  // The Done mark is carried the way the state override is, and re-checked the
  // same way: the union's newest message is the test, so mail from the *other*
  // mailbox that this row never saw brings the thread back too.
  const done =
    decided.done && activeDone({ done: decided.done, lastMessageAt }) !== null
      ? decided.done
      : null

  // Reading is the one field a merge has to *union* rather than pick: the two
  // mailboxes hold overlapping copies of the same thread, and reading it in
  // either means the user has read the mail. Taking the newest mark is that
  // union; taking the owning row's alone would show the whole thread unread again
  // after reading it in the other mailbox.
  // `readIn` rather than `seen`: the merge has a `seen` of its own further up, and
  // shadowing it here is how the wrong timestamp gets compared.
  const seenAt = cluster.reduce<Date | null>((newest, source) => {
    const readIn = source.conversation.seenAt
    if (!readIn) return newest
    if (!newest || readIn.getTime() > newest.getTime()) return readIn
    return newest
  }, null)

  // The mailbox's read flag unions the same way, and in the other direction: a
  // thread is unread when *any* copy of it is, because Gmail's flag on either
  // mailbox is still Gmail's answer about the same mail. Null only when no
  // source could say, so the merged row keeps the local fallback.
  const unread = cluster.reduce<boolean | null>((state, source) => {
    const sourceUnread = source.conversation.unread
    if (sourceUnread === null) return state
    return sourceUnread === true ? true : (state ?? false)
  }, null)

  return {
    id: owner.conversation.id,
    providerThreadId: owner.conversation.providerThreadId,
    subject: owner.conversation.subject,
    participants,
    messages,
    attachments,
    // The owner's copy decides the folder: the thread is the same mail, and the
    // account that owns it is the one whose labels are authoritative.
    folder: owner.conversation.folder,

    state: ccOnly ? 'low-priority' : (override ?? derived.state),
    awaitingReply: ccOnly ? false : derived.awaitingReply,
    requiresReply: ccOnly ? false : derived.requiresReply,
    importance: importanceOverride?.importance ?? derived.importance,
    urgency: ccOnly ? 2 : derived.urgency,
    intent: derived.intent,

    isAutomated: derived.isAutomated,
    replyable: rebuiltIsAutomated || decidedNoReply ? false : derived.replyable,

    messageCount: messages.length,
    attachmentCount: attachments.length,
    lastMessageAt,

    topic,
    goal,
    // Where the user filed it is theirs, so the owning row's answer is carried
    // rather than recomputed from the union.
    organizationGroupId: owner.conversation.organizationGroupId,

    // Carried rather than re-derived, and nulled here when the union has moved
    // past it, so a reader of the merged row sees the same call (or the same
    // absence of one) the owning row holds.
    stateOverride: override ? decided.stateOverride : null,
    importanceOverride,
    seenAt,
    unread,
    done,
  }
}

/**
 * Split the merged rows into the state groups and the done pile.
 *
 * A done thread is deliberately *out* of the state groups. The state says what
 * the mail needs and done says the user has already dealt with it, so leaving a
 * finished thread among the work is what made the two indistinguishable — the
 * group heading claimed work that was no longer there. The state itself is kept
 * on the row (the tag still shows it, faintly), because "done" is not a claim
 * about the mail, and the decision layer may well file it the same way again.
 *
 * Pure, and here rather than in the loader, because it is the rule that decides
 * what the inbox shows, and it has to be testable without a database.
 */
export function partitionByState(rows: MergedConversation[]): {
  counts: Record<ConversationState, number>
  doneCount: number
} {
  const counts: Record<ConversationState, number> = {
    'needs-action': 0,
    'waiting-for-reply': 0,
    informational: 0,
    'low-priority': 0,
  }
  let doneCount = 0

  for (const row of rows) {
    // `activeDone` rather than the raw mark: a done thread that has since
    // received mail is work again, and goes back to its own group by itself.
    if (activeDone(row.conversation) !== null) {
      doneCount += 1
      continue
    }

    counts[row.conversation.state] += 1
  }

  return { counts, doneCount }
}

/** Union attachments across mailboxes, collapsing copies of the same file. */
function dedupeAttachments(
  attachments: ConversationAttachment[],
): ConversationAttachment[] {
  const seen = new Set<string>()
  const out: ConversationAttachment[] = []
  for (const attachment of attachments) {
    const key = attachmentKey(attachment)
    if (key !== null && seen.has(key)) continue
    if (key !== null) seen.add(key)
    out.push(attachment)
  }
  return out
}
