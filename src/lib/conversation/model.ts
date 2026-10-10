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
  gmailMessageId: string
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
  gmailMessageId: string
  messageId: string | null
  gmailAttachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
  isInline: boolean
  contentId: string | null
}

export type Conversation = {
  /** Derived, stable key. */
  id: string
  gmailThreadId: string
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
}

/** Attachment metadata, when the source can supply it. */
export type AttachmentRef = {
  gmailMessageId: string
  gmailAttachmentId: string
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
  gmailThreadId: string
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
    const detectedQuote = stripQuotedText(text)
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    const quoteStart = findQuoteStart(lines)
    // `stripQuotedText` deliberately keeps all-quote forwards intact. Only
    // split the message when stripping actually found a quote to remove.
    const hasRemovableQuote = quoteStart >= 0 && detectedQuote.quote !== null
    const userText = hasRemovableQuote
      ? lines.slice(0, quoteStart).join('\n').trim()
      : text.trim()
    const retainedQuote =
      !shouldStripQuote && hasRemovableQuote
        ? lines.slice(quoteStart).join('\n').trim()
        : null
    quote = shouldStripQuote ? detectedQuote.quote : null

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
    gmailMessageId:
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
    .filter((m) => m.body.trim().length > 0 || m.gmailMessageId)

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
    id: conversationId(context.ownerEmail, context.gmailThreadId),
    gmailThreadId: context.gmailThreadId,
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
  gmailThreadId: string,
): string {
  return `${normaliseEmail(ownerEmail)}:${gmailThreadId}`
}

/** Map adapter-supplied attachment metadata into the domain shape. */
function toConversationAttachment(ref: AttachmentRef): ConversationAttachment {
  return {
    gmailMessageId: ref.gmailMessageId,
    messageId: ref.gmailMessageId,
    gmailAttachmentId: ref.gmailAttachmentId,
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
        gmailMessageId: messageId,
        messageId,
        gmailAttachmentId: attachmentId(messageId, part),
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
  // that a reply is expected.
  const lastBody = last.body.toLowerCase()
  const asksQuestion =
    /\?/.test(lastBody) &&
    /\b(can|could|would|should|do you|did you|are you|is there|any chance|please)\b/.test(
      lastBody,
    )

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
    intent: inferIntent(last.body, asksQuestion),
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
