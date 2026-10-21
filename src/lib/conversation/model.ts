/**
 * Conversation model.
 *
 * A Gmail thread becomes a *conversation with state*. This module is pure: it
 * takes parsed messages and returns plain data. No database, no Gmail API, no
 * framework — so every rule here is directly testable.
 *
 * The pipeline is:
 *
 *   ParsedMessage[]  ->  clean each message  ->  derive state  ->  Conversation
 */

import {
  extractHtmlBody,
  findQuoteStart,
  sanitizeEmailHtml,
  selectAttachments,
  selectBodyPart,
  stripCidPlaceholders,
  stripGreeting,
  stripHtmlGreeting,
  stripHtmlSignature,
  stripQuotedHtml,
  stripQuotedText,
  stripSignature,
  stripInvisibleCharacters,
} from '#/lib/mail/index.ts'
import type { MailPart, ParsedMessage } from '#/lib/mail/index.ts'
import type { ConversationState, Intent, Participant } from '#/db/schema.ts'

import { isAutomatedThread } from './automated.ts'

/** A single message inside a conversation, cleaned for chat display. */
export type ParsingPreferences = {
  stripQuotedHistory: boolean
  stripGreeting: boolean
  stripSignature: boolean
}

export type ConversationMessage = {
  /** Stable id: the Gmail message id. */
  providerMessageId: string
  /**
   * The RFC 5322 `Message-ID`, when the source had one.
   *
   * Needed to put `In-Reply-To` / `References` on outgoing mail. Without them a
   * reply threads correctly inside Gmail but arrives as a loose message in
   * Outlook and Apple Mail.
   */
  internetMessageId: string | null
  from: Participant
  to: Participant[]
  cc: Participant[]
  subject: string
  snippet: string | null
  /** Original text body retained locally so future parser improvements can recover removed content. */
  rawBodyText?: string | null
  /** Original HTML body retained locally so future parser improvements can recover removed content. */
  rawBodyHtml?: string | null
  /** Body with greeting, signature and quoted history removed. */
  body: string
  /** HTML body retained for rich rendering, with quoted history stripped. */
  bodyHtml: string | null
  greeting: string | null
  signature: string | null
  /** True when the account owner sent this message. */
  isFromOwner: boolean
  sentAt: Date
  /** Detected sender's greeting/signature, kept visible when not stripped. */
  detectedGreeting?: string | null
  detectedSignature?: string | null
  /** Restorable text removed from this message during parsing. */
  strippedGreeting?: string | null
  strippedSignature?: string | null
  strippedQuote?: string | null
  replyGreeting?: string | null
  replySignature?: string | null
  parsingPreferences?: ParsingPreferences
}

export type ConversationAttachment = {
  /** Provider thread containing this mailbox-scoped attachment reference. */
  providerThreadId?: string
  providerMessageId: string
  messageId: string | null
  providerAttachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
  isInline: boolean
  contentId: string | null
}

/**
 * The user's own call on what a thread is worth, and the activity it was made
 * against.
 *
 * `messageAt` is the point of the call rather than a copy of the thread: the
 * user judged the messages that existed when they clicked, so a later message
 * voids it. Storing the timestamp (rather than a flag) is what lets a thread
 * they filed away come back on its own when someone writes again.
 */
export type StateOverride = {
  state: ConversationState
  messageAt: Date
}

/**
 * The user's live call on a conversation, or null when there is none.
 *
 * A call the thread has outrun counts as none: "not important" was said about
 * the mail that existed at the time, and whatever arrived afterwards has not
 * been judged. Kept here, in the pure model, because the merge, the decision
 * fold and the inbox all have to answer this question the same way.
 */
export function activeStateOverride(
  conversation: Pick<Conversation, 'stateOverride' | 'lastMessageAt'>,
): ConversationState | null {
  const override = conversation.stateOverride
  if (!override) return null

  return conversation.lastMessageAt.getTime() <= override.messageAt.getTime()
    ? override.state
    : null
}

/**
 * When the user marked this thread done, or null when it is not (or no longer)
 * done.
 *
 * Returns a time rather than a boolean so the caller can say *when* it was
 * handled. A mark the thread has outrun counts as none: the user said "done"
 * about the mail that existed then, and anything that arrived afterwards is new
 * work — which is exactly the promise the mark makes ("you will not lose a thread
 * you still have to answer").
 *
 * Kept in the pure model, like `activeStateOverride`, because three places ask
 * it — the row, the merged cluster and the inbox list — and they have to answer
 * the same way.
 */
export function activeDone(
  conversation: Pick<Conversation, 'done' | 'lastMessageAt'>,
): Date | null {
  const done = conversation.done
  if (!done) return null

  return conversation.lastMessageAt.getTime() <= done.messageAt.getTime()
    ? done.doneAt
    : null
}

/**
 * Messages the user has not seen yet — the ones that make a thread look new.
 *
 * Only incoming mail counts. The user's own reply is not news to them, and a
 * thread whose newest message is theirs should not go back to looking unread the
 * moment they send it.
 */
export function unseenMessages(
  conversation: Pick<Conversation, 'messages' | 'seenAt'>,
): ConversationMessage[] {
  const seen = conversation.seenAt?.getTime() ?? 0
  return conversation.messages.filter(
    (message) => !message.isFromOwner && message.sentAt.getTime() > seen,
  )
}

/**
 * The address on the other side of a thread — its newest message not written by
 * the user.
 *
 * Empty when the user has only ever written in it. That is the right answer for a
 * lookup by address: they have never filed *themselves* away, and a preference
 * stored against their own address means nothing.
 *
 * Kept here, as one definition, because three places ask this question: the
 * decision path looking up what the user taught the app about a sender, the sweep
 * that applies a new mark to already-stored threads, and the conversation view
 * resolving which sender's preferences to show. `isFromOwner` decides it rather
 * than a comparison against one address — an install can have several connected
 * mailboxes, and a message any of them sent is still the user's.
 *
 * Typed structurally so a caller holding only message rows (the sweep, which
 * reads `from`/`isFromOwner`/`sentAt` and nothing else) can use it without
 * building whole conversations first.
 */
export function otherPartyOf(conversation: {
  messages: ReadonlyArray<{
    from: { email: string }
    isFromOwner: boolean
  }>
}): string {
  const incoming = [...conversation.messages]
    .reverse()
    .find((message) => !message.isFromOwner)

  return incoming?.from.email.trim().toLowerCase() ?? ''
}

/** The greeting and signature a reply goes out with. */
export type ReplyStyle = {
  greeting: string | null
  signature: string | null
}

/**
 * Which greeting and signature a reply is composed with.
 *
 * Three sources, in order of authority: a sender-specific pair the user enabled,
 * the account-wide pair, and — the fallback that matters — the user's *own* most
 * recent message in the thread. The last one is what makes a reply look like the
 * user wrote it rather than like the app guessed: whatever they actually signed
 * with here beats anything stored.
 *
 * One definition because two callers now need the same answer: the send path
 * (which puts these on the message) and the draft path (which tells the model not
 * to write its own, because one is arriving anyway). Divergence between them is
 * the duplicate-greeting bug, so they share this.
 */
export function resolveReplyStyle(input: {
  /** Account-wide greeting/signature; null when the user set none. */
  account: ReplyStyle
  /** The sender's own pair, used only when it is switched on. */
  sender?: {
    enabled: boolean
    greeting: string | null
    signature: string | null
  } | null
  /** The user's own newest message in this thread, as the fallback. */
  lastOwnerMessage?: {
    greeting?: string | null
    signature?: string | null
    detectedGreeting?: string | null
    detectedSignature?: string | null
  } | null
}): ReplyStyle {
  if (input.sender?.enabled) {
    return {
      greeting: input.sender.greeting ?? null,
      signature: input.sender.signature ?? null,
    }
  }

  const last = input.lastOwnerMessage
  return {
    greeting:
      input.account.greeting ??
      last?.detectedGreeting ??
      last?.greeting ??
      null,
    signature:
      input.account.signature ??
      last?.detectedSignature ??
      last?.signature ??
      null,
  }
}

export type Conversation = {
  /** Derived, stable key. */
  id: string
  providerThreadId: string
  subject: string
  participants: Participant[]
  messages: ConversationMessage[]
  attachments: ConversationAttachment[]

  state: ConversationState
  /**
   * No human on the other side — every message came from the owner or a no-reply
   * sender. Affects presentation only: the state is still derived normally, so a
   * failed build is still `needs-action`. See `automated.ts`.
   */
  isAutomated: boolean
  /**
   * Whether the conversation can be replied to. Deterministic machine mail is
   * settled first; the decision model decides the rest. False hides the reply box.
   */
  replyable: boolean
  awaitingReply: boolean
  requiresReply: boolean
  importance: number
  urgency: number
  intent: Intent

  messageCount: number
  attachmentCount: number
  lastMessageAt: Date

  /**
   * Topic is *not* inferred here. It starts null and is filled in by the
   * decision layer (or the user). Deriving it from the subject is tempting but
   * produces "Re: Re: Fwd:" noise.
   */
  topic: string | null
  /** User-owned. Never written by the model. */
  goal: string | null

  /**
   * The user's own call on the state, or null when they have made none.
   *
   * Like `topic` and `goal`, this is theirs rather than the decision layer's,
   * and it outranks it: a re-decide may disagree with everything else on this
   * object, but the thread stays where the user put it. See
   * `activeStateOverride` for what makes a call current.
   */
  stateOverride: StateOverride | null

  /**
   * Sent time of the newest message the user has seen, or null when they have
   * never opened the thread. Everything older than it is read; anything newer is
   * new mail. See `unseenMessages`.
   *
   * Reading is not doing: this is set by opening a thread and never moves the
   * state or the Done mark.
   */
  seenAt: Date | null

  /**
   * The user's own "done" mark, or null when they have made none. See
   * `activeDone` for what makes a mark current.
   */
  done: DoneMark | null
}

/**
 * The user saying a thread is handled, and the mail they said it about.
 *
 * The same shape as `StateOverride` on purpose: a mark is a judgement about the
 * messages that existed at the time, so the thread's last activity at that moment
 * is what decides whether it is still current.
 */
export type DoneMark = { doneAt: Date; messageAt: Date }

/** Attachment metadata, when the source can supply it. */
export type AttachmentRef = {
  providerMessageId: string
  providerAttachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
  isInline: boolean
  contentId: string | null
}

/** Everything the builder needs to know about the local user. */
export type BuildContext = {
  /** The account owner's own email address. */
  ownerEmail: string
  /** Gmail thread id. */
  providerThreadId: string
  /**
   * Optional attachment metadata.
   *
   * Gmail's structured (`format: 'full'`) payload carries attachment size,
   * filename and disposition in the MIME tree but *not* the bytes, so it cannot
   * be derived from `ParsedMessage.parts`. The Gmail adapter supplies these.
   */
  attachments?: AttachmentRef[]
  /** Account-wide parsing defaults, overridden for senders with a profile. */
  parsingDefaults?: Partial<ParsingPreferences>
  /** Per-sender overrides; omitted fields inherit account defaults. */
  parsingPreferences?: Record<string, Partial<ParsingPreferences>>
  /** Per-sender reply style and account-wide defaults. */
  replyStyles?: {
    account: { greeting: string | null; signature: string | null }
    senders: Record<
      string,
      {
        enabled: boolean
        greeting: string | null
        signature: string | null
      }
    >
  }
}

/** Normalise an address for comparison: case-insensitive, no whitespace. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Whether a typed address could be a sender the user cannot reply to.
 *
 * Shape only, deliberately: a mark is a *preference*, not a delivery, so this has
 * to reject what could never be an address — `updates@`, `nope`, two addresses
 * pasted at once, a whole header line — and nothing more. There is no "must have a
 * dot" rule: local addresses exist, and one rule that rejected a real address
 * would be worse than the entry that simply never matches. Whether mail actually
 * arrives from an address is settled elsewhere, by the sweep over stored threads
 * and by every decision that reads the stored row.
 *
 * Compared in its normalised form, so `Updates@Acme.Example` is judged as the
 * address it will be stored as.
 */
export function isSenderAddress(input: string): boolean {
  const address = normaliseEmail(input)
  // 320 is the RFC's own ceiling on an address, so anything longer is not one.
  if (!address || address.length > 320 || /\s/.test(address)) return false

  const at = address.indexOf('@')
  // Exactly one `@`, with something on each side of it.
  return at >= 1 && at === address.lastIndexOf('@') && at < address.length - 1
}

/** Split "Name <a@b.c>" into a participant. */
export function toParticipant(raw: string): Participant {
  const trimmed = raw.trim()
  const match = trimmed.match(/^(.*?)<(.+?)>$/)

  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, '')
    return { name: name || null, email: normaliseEmail(match[2]) }
  }

  return { name: null, email: normaliseEmail(trimmed) }
}

/**
 * Clean one message for chat display.
 *
 * Plain text is preferred because its quoting is already normalised. HTML is
 * used when there's no plain alternative, and always kept separately so the UI
 * can render rich content when it wants to.
 */
export function cleanMessage(
  message: ParsedMessage,
  ownerEmail: string,
  preferences: Partial<ParsingPreferences> = {},
): ConversationMessage {
  const { text, html } = selectBodyPart(message)

  let greeting: string | null = null
  let signature: string | null = null
  let quote: string | null = null
  let body = ''
  const shouldStripQuote = preferences.stripQuotedHistory ?? true
  const shouldStripGreeting = preferences.stripGreeting ?? true
  const shouldStripSignature = preferences.stripSignature ?? true

  // The plain-text part decides what the user typed. It is quoted with markers
  // that strip reliably, and it is what `strip.ts` has always been tuned on, so
  // it stays authoritative even when an HTML alternative exists.
  if (text) {
    // A signature logo arrives from the sender's client as the literal text
    // `[cid:logo]` in the plain-text alternative. The signature is stored and
    // handed back when replying, so leaving it in put a placeholder in the
    // user's own reply.
    const visible = stripCidPlaceholders(text)
    const detectedQuote = stripQuotedText(visible)
    const lines = visible
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
    const quoteStart = findQuoteStart(lines)
    // Some clients mark quoted history only in HTML. When that structural
    // evidence exists and the plain alternative has no recognizable boundary,
    // use the HTML projection so the prior conversation is neither duplicated
    // nor mistaken for the sender's new text.
    const htmlExtracted = html ? extractHtmlBody(html) : null
    const htmlHasQuote = Boolean(htmlExtracted?.quote && htmlExtracted.body)
    // `stripQuotedText` deliberately keeps all-quote forwards intact. Only
    // split the text part when stripping actually found a quote to remove.
    const hasRemovableQuote = quoteStart >= 0 && detectedQuote.quote !== null
    const userText =
      htmlHasQuote && !hasRemovableQuote
        ? htmlExtracted!.body
        : hasRemovableQuote
          ? lines.slice(0, quoteStart).join('\n').trim()
          : visible.trim()
    const detectedQuoteText = hasRemovableQuote
      ? lines.slice(quoteStart).join('\n').trim()
      : htmlHasQuote
        ? htmlExtracted!.quote
        : null
    const retainedQuote = !shouldStripQuote ? detectedQuoteText : null
    quote = shouldStripQuote ? detectedQuoteText : null

    const detectedSigned = stripSignature(userText)
    signature = detectedSigned.signature
    const signed = shouldStripSignature
      ? detectedSigned
      : { body: userText, signature: null }

    const detectedGreeted = stripGreeting(detectedSigned.body)
    greeting = detectedGreeted.greeting
    const greeted = shouldStripGreeting
      ? stripGreeting(signed.body)
      : { body: signed.body, greeting: null }

    body = [greeted.body, retainedQuote].filter(Boolean).join('\n\n')
  } else if (html) {
    // HTML-only mail: split quote containers into own text and restorable quote.
    // The DOM extractor handles nested quote containers and keeps the rich HTML
    // body below, so text and HTML follow the same per-sender preferences.
    const extracted = extractHtmlBody(html)
    const userText = extracted.body
    quote = shouldStripQuote ? extracted.quote : null
    const detectedSigned = stripSignature(userText)
    signature = detectedSigned.signature
    const signed = shouldStripSignature
      ? detectedSigned
      : { body: userText, signature: null }
    const detectedGreeted = stripGreeting(detectedSigned.body)
    greeting = detectedGreeted.greeting
    const greeted = shouldStripGreeting
      ? stripGreeting(signed.body)
      : { body: signed.body, greeting: null }
    const retainedQuote = shouldStripQuote ? null : extracted.quote
    body = [greeted.body, retainedQuote].filter(Boolean).join('\n\n')
  }

  body = stripInvisibleCharacters(body)

  // HTML is kept for every message that has one, not only HTML-only mail. A
  // newsletter or a table-formatted receipt arrives as multipart/alternative,
  // and flattening it to text throws away the formatting that made it readable
  // in the first place.
  //
  // Sanitised and trimmed here rather than at render time: what lands in
  // `messages.body_html` is what is safe to inject, so no component has to
  // remember to clean it first.
  const bodyHtml = html
    ? prepareHtmlBody(
        html,
        shouldStripGreeting ? greeting : null,
        shouldStripSignature ? signature : null,
        shouldStripQuote,
      )
    : null

  const isFromOwner =
    normaliseEmail(message.from) === normaliseEmail(ownerEmail)

  return {
    providerMessageId:
      message.messageId ?? `synthetic:${message.date?.getTime() ?? 0}`,
    internetMessageId: message.messageId ?? null,
    from: {
      ...toParticipant(message.from),
      name: message.fromName ?? toParticipant(message.from).name,
    },
    to: message.to.map(toParticipant),
    cc: message.cc.map(toParticipant),
    subject: message.subject,
    snippet: null,
    rawBodyText: text,
    rawBodyHtml: html,
    body,
    bodyHtml,
    greeting: shouldStripGreeting ? greeting : null,
    signature: shouldStripSignature ? signature : null,
    detectedGreeting: greeting,
    detectedSignature: signature,
    strippedGreeting: shouldStripGreeting ? greeting : null,
    strippedSignature: shouldStripSignature ? signature : null,
    strippedQuote: shouldStripQuote ? quote : null,
    replyGreeting: null,
    replySignature: null,
    parsingPreferences: {
      stripQuotedHistory: shouldStripQuote,
      stripGreeting: shouldStripGreeting,
      stripSignature: shouldStripSignature,
    },
    isFromOwner,
    sentAt: message.date ?? new Date(0),
  }
}

/**
 * Reduce an HTML body to what is safe to render and what the user actually wrote.
 *
 * The order is load-bearing and runs quote-first: quote-stripping keys off the
 * `class` / `id` attributes clients put on quote containers, and sanitising keeps
 * those attributes, so the reverse order would strip the evidence before using
 * it.
 *
 * Greeting and signature come from the plain-text pass, so they are the same
 * strings `strip.ts` detected — this only deletes them from the HTML.
 */
function prepareHtmlBody(
  html: string,
  greeting: string | null,
  signature: string | null,
  stripQuote: boolean,
): string | null {
  const unquoted = stripQuotedHtml(html, { enabled: stripQuote })
  const greeted = stripHtmlGreeting(unquoted, greeting)
  const signed = stripHtmlSignature(greeted, signature)

  const clean = sanitizeEmailHtml(signed)

  // Nothing renderable survived. Returning null rather than an empty string
  // keeps the view's "fall back to plain text" decision a simple null check.
  return clean ? clean : null
}

/** Latest greeting/signature from the user's own sent mail, if present. */
function lastDetectedOwnerStyle(
  messages: ParsedMessage[],
  ownerEmail: string,
  kind: 'greeting' | 'signature',
): string | null {
  const owner = normaliseEmail(ownerEmail)
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages.at(i)
    if (!message || normaliseEmail(message.from) !== owner) {
      continue
    }
    const text = selectBodyPart(message).text
    if (!text) continue
    const quoted = stripQuotedText(text)
    const signed = stripSignature(quoted.body)
    if (kind === 'signature' && signed.signature) return signed.signature
    const greeted = stripGreeting(signed.body)
    if (kind === 'greeting' && greeted.greeting) return greeted.greeting
  }
  return null
}

/** Remove duplicate participants, preserving first-seen order. */
export function dedupeParticipants(participants: Participant[]): Participant[] {
  const seen = new Set<string>()
  const out: Participant[] = []

  for (const p of participants) {
    if (!p.email || seen.has(p.email)) continue
    seen.add(p.email)
    out.push(p)
  }

  return out
}

/**
 * Build a conversation from a thread's messages.
 *
 * Messages are sorted by date first — Gmail does not guarantee thread order, and
 * every downstream rule (who spoke last, do we await a reply) depends on it.
 */
export function buildConversation(
  messages: ParsedMessage[],
  context: BuildContext,
): Conversation {
  const sorted = [...messages].sort(
    (a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0),
  )

  const cleaned = sorted
    .map((m) => {
      const senderEmail = normaliseEmail(m.from)
      const senderPreferences = context.parsingPreferences?.[senderEmail]
      const preferences: ParsingPreferences = {
        stripQuotedHistory:
          senderPreferences?.stripQuotedHistory ??
          context.parsingDefaults?.stripQuotedHistory ??
          true,
        stripGreeting:
          senderPreferences?.stripGreeting ??
          context.parsingDefaults?.stripGreeting ??
          true,
        stripSignature:
          senderPreferences?.stripSignature ??
          context.parsingDefaults?.stripSignature ??
          true,
      }
      const cleanedMessage = cleanMessage(m, context.ownerEmail, preferences)
      const style = context.replyStyles?.senders[senderEmail]
      const greeting = style?.enabled
        ? style.greeting
        : (context.replyStyles?.account.greeting ??
          lastDetectedOwnerStyle(sorted, context.ownerEmail, 'greeting'))
      const signature = style?.enabled
        ? style.signature
        : (context.replyStyles?.account.signature ??
          lastDetectedOwnerStyle(sorted, context.ownerEmail, 'signature'))

      return {
        ...cleanedMessage,
        replyGreeting: cleanedMessage.isFromOwner ? null : greeting,
        replySignature: cleanedMessage.isFromOwner ? null : signature,
        parsingPreferences: preferences,
      }
    })
    .filter((m) => m.body.trim().length > 0 || m.providerMessageId)

  // `.at(-1)` rather than `[length - 1]`: the index form is typed `T` without
  // `noUncheckedIndexedAccess`, which hides the real empty-thread case.
  const last = cleaned.at(-1)

  const participants = dedupeParticipants([
    ...cleaned.flatMap((m) => [m.from, ...m.to, ...m.cc]),
  ])

  const attachments = context.attachments
    ? context.attachments.map(toConversationAttachment)
    : collectAttachments(sorted)

  const subject = strippedReplyPrefix(sorted[0]?.subject ?? '') || 'No subject'

  const decision = deriveState(cleaned, {
    ownerEmail: context.ownerEmail,
    lastMessageAt: last?.sentAt ?? new Date(0),
    now: new Date(),
  })

  // Step 1 of replyability: machine mail is not replyable. The decision model
  // fills in the rest (a letter from a person that still expects no answer).
  const isAutomated = isAutomatedThread(cleaned, context.ownerEmail)

  return {
    id: conversationId(context.ownerEmail, context.providerThreadId),
    providerThreadId: context.providerThreadId,
    subject,
    participants,
    messages: cleaned,
    attachments,

    state: decision.state,
    awaitingReply: decision.awaitingReply,
    requiresReply: decision.requiresReply,
    importance: decision.importance,
    urgency: decision.urgency,
    intent: decision.intent,

    isAutomated,
    replyable: !isAutomated,

    messageCount: cleaned.length,
    attachmentCount: attachments.length,
    lastMessageAt: last?.sentAt ?? new Date(0),

    topic: null,
    goal: null,
    // Set by whoever knows about the stored row — a freshly built conversation
    // has no access to the user's calls, and assuming the call away here would
    // let a sync overwrite one.
    stateOverride: null,
    // Same reason, and it covers reading as well as saying "done": a rebuild from
    // Gmail knows nothing about either, and defaulting `seenAt` to now would make
    // every rebuilt thread silently look read.
    seenAt: null,
    done: null,
  }
}

/** Remove "Re:" / "Fwd:" prefixes so the subject reads cleanly. */
export function strippedReplyPrefix(subject: string): string {
  let out = subject.trim()
  // Repeat: "Re: Re: Fwd: thing".
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/^(re|fwd|fw|aw|sv|vs)\s*(\[\d+\])?\s*:\s*/i, '')
    if (next === out) break
    out = next
  }
  return out.trim()
}

/** Deterministic conversation id from owner + thread. */
export function conversationId(
  ownerEmail: string,
  providerThreadId: string,
): string {
  return `${normaliseEmail(ownerEmail)}:${providerThreadId}`
}

/** Map adapter-supplied attachment metadata into the domain shape. */
function toConversationAttachment(ref: AttachmentRef): ConversationAttachment {
  return {
    providerMessageId: ref.providerMessageId,
    messageId: ref.providerMessageId,
    providerAttachmentId: ref.providerAttachmentId,
    filename: ref.filename,
    mimeType: ref.mimeType,
    sizeBytes: ref.sizeBytes,
    isInline: ref.isInline,
    contentId: ref.contentId,
  }
}

/** Flatten attachments across the thread, keyed to their message. */
function collectAttachments(
  messages: ParsedMessage[],
): ConversationAttachment[] {
  const out: ConversationAttachment[] = []

  messages.forEach((message, index) => {
    // Index aligns with the sorted order used in buildConversation.
    const messageId = message.messageId ?? `idx-${index}`

    for (const part of selectAttachments(message)) {
      out.push({
        providerMessageId: messageId,
        messageId,
        providerAttachmentId: attachmentId(messageId, part),
        filename: part.filename ?? 'attachment',
        mimeType: part.contentType,
        isInline: part.disposition === 'inline',
        contentId: part.contentId ?? null,
        sizeBytes: 0,
      })
    }
  })

  return out
}

/** Stable id for an attachment within its message. */
function attachmentId(messageId: string, part: MailPart): string {
  return `${messageId}:${part.filename ?? 'unnamed'}:${part.contentType}`
}

/**
 * Lines that are about the mailing rather than written to the reader.
 *
 * Deliberately phrase-based rather than "contains a link": a real request can
 * carry a URL, and the point is to recognise the furniture that every bulk mail
 * ends with, not to guess at layout. Multi-lingual where the mailbox needs it,
 * like the signature list in `strip.ts`.
 */
const BULK_FOOTER_PATTERNS = [
  /\b(can'?t|cannot|unable to) see (this|the) (email|message)\b/i,
  /\bview (this|the) (email|message) in\b/i,
  /\bview (it|this) in (your )?(browser|web browser)\b/i,
  /\bunsubscribe\b/i,
  /\b(email|notification|communication) (preferences|settings)\b/i,
  /\b(update|manage|change) (your )?(preferences|subscription|subscriptions|settings)\b/i,
  /\bprivacy policy\b/i,
  /\bterms (of service|and conditions)\b/i,
  /\bcontact (us|support|your administrator)\b/i,
  /\bhelp ?(centre|center)\b/i,
  /\bsupport team\b/i,
  /\b(any )?questions\?/i,
  /\bquestions or concerns\b/i,
  /\bdon'?t hesitate to\b/i,
  /\bfeel free to (reach out|contact|ask)\b/i,
]

/** Is this one line the kind of thing bulk mail says about itself? */
function isBulkFooterLine(line: string): boolean {
  const text = line.trim()
  if (!text) return false
  return BULK_FOOTER_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * The part of a message a request could plausibly be written in.
 *
 * A `?` anywhere in the body is not a request. "Can't see this email? View it in
 * your browser." and "Questions? Please contact support." are the last lines of
 * most bulk mail, and both used to file a newsletter under `needs-action`.
 *
 * The filter is unconditional, including when it leaves nothing — a message made
 * only of furniture is bulk by definition, and re-admitting those lines to be
 * safe would put every newsletter's "Do you have questions?" back in Needs
 * action, which is the bug. The cost is a one-line mail phrased exactly like a
 * footer; it stays listed and replyable, just not filed as work.
 */
function requestText(body: string): string {
  return body
    .split('\n')
    .filter((line) => !isBulkFooterLine(line))
    .join('\n')
}

/**
 * Does the reader actually get asked for something?
 *
 * Still conservative, and deliberately not "contains a modal verb": `Please
 * contact support` is a call to action, `Can't see this email` is a mail-client
 * workaround, and `Do you have any questions` is an offer of help. What is left
 * is a modal aimed at a person (`can you`, `could we`), or an explicit
 * `please <verb>`. The question mark is still required — an ask without one is a
 * statement, and the false-positive direction is the expensive one.
 */
const REQUEST_PATTERNS = [
  // A modal with someone to act on, followed by the action: `can you send`,
  // `could we move`. The verb is what separates an ask from a word search — and
  // it is why `do you have questions` is not one.
  /\b(can|could|would|will|should)\s+(you|we|i|someone|anyone|anybody)\s+\w+/,
  /\b(any chance|would you mind|how about)\b/,
  /\bplease\s+(send|confirm|review|reply|respond|check|update|sign|approve|share|provide|advise|call|book|schedule|cancel|pay|complete|fill|fix|let)\b/,
]

function asksForSomething(text: string): boolean {
  if (!text.includes('?')) return false
  const lower = text.toLowerCase()
  return REQUEST_PATTERNS.some((pattern) => pattern.test(lower))
}

/**
 * Rule-based state derivation.
 *
 * This is a deterministic placeholder for the decision layer described in the
 * spec (see PLAN.md). It is deliberately conservative: it only claims a state
 * it can justify from the message flow, and defers to the LLM for anything
 * subtler like importance. The interface is what matters — swapping in a real
 * decision layer must not change anything upstream.
 */
export function deriveState(
  messages: Array<Pick<ConversationMessage, 'isFromOwner' | 'sentAt' | 'body'>>,
  ctx: { ownerEmail: string; lastMessageAt: Date; now: Date },
): {
  state: ConversationState
  awaitingReply: boolean
  requiresReply: boolean
  importance: number
  urgency: number
  intent: Intent
} {
  if (messages.length === 0) {
    return {
      state: 'informational',
      awaitingReply: false,
      requiresReply: false,
      importance: 5,
      urgency: 3,
      intent: 'unknown',
    }
  }

  const last = messages[messages.length - 1]
  const lastIsOwner = last.isFromOwner

  // The ball is in their court if we spoke last.
  const awaitingReply = lastIsOwner

  // A question aimed at us, with nothing sent after it, is the clearest signal
  // that a reply is expected. Bulk-mail furniture is dropped first, because a
  // "?" in a footer is about the mailing, not a request to the reader.
  const visible = requestText(last.body)
  const asksQuestion = asksForSomething(visible)

  const requiresReply = !lastIsOwner && asksQuestion

  const ageMs = ctx.now.getTime() - ctx.lastMessageAt.getTime()
  const ageDays = ageMs / (1000 * 60 * 60 * 24)

  // Urgency decays with age: an unanswered question from last week is less urgent
  // than one from this morning.
  let urgency = 5
  if (ageDays <= 1) urgency = 8
  else if (ageDays <= 3) urgency = 7
  else if (ageDays <= 7) urgency = 5
  else if (ageDays <= 30) urgency = 3
  else urgency = 2

  if (requiresReply) urgency = Math.min(10, urgency + 1)

  // Importance is a placeholder until the decision layer lands. Longer threads
  // imply sustained attention; a single automated notice does not.
  let importance = 5
  if (messages.length === 1) importance = 4
  else if (messages.length > 4) importance = 7

  const state: ConversationState = requiresReply
    ? 'needs-action'
    : awaitingReply
      ? 'waiting-for-reply'
      : 'informational'

  return {
    state,
    awaitingReply,
    requiresReply,
    importance,
    urgency,
    intent: inferIntent(visible, asksQuestion),
  }
}

/**
 * Cheap intent classification.
 *
 * Keyword-based and intentionally shallow — it exists to group conversations in
 * the MVP, and the decision layer replaces it with something that reads the
 * whole thread.
 */
export function inferIntent(body: string, asksQuestion: boolean): Intent {
  const text = body.toLowerCase()

  if (
    /\b(invoice|payment|receipt|order confirmation|your account)\b/.test(text)
  ) {
    return 'transactional'
  }
  if (
    /\b(unsubscribe|limited time|%\s*off|sale|deal of the week)\b/.test(text)
  ) {
    return 'promotion'
  }
  if (
    /\b(let'?s schedule|calendar|meeting|call|tuesday|wednesday|thursday|monday|friday)\b/.test(
      text,
    )
  ) {
    return 'scheduling'
  }
  if (asksQuestion) return 'request'
  if (
    /\b(i wanted to share|just an update|fyi|for your information|announc)/.test(
      text,
    )
  ) {
    return 'update'
  }
  if (/\b(i propose|suggest|proposal|would like to propose)\b/.test(text)) {
    return 'proposal'
  }
  if (/\b(thanks|thank you|appreciate|following up)\b/.test(text)) {
    return 'response'
  }

  return 'unknown'
}
