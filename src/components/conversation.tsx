/**
 * The conversation view: a thread rendered as chat.
 *
 * Owner's messages sit on the right, everyone else's on the left, and the
 * greeting and signature are absent because the parser removed them — they are
 * restored on send instead.
 *
 * Built from plain markup rather than the ReUI `Timeline`. That component is a
 * progress stepper: every item takes a `step` number and draws a connector from
 * `activeStep`, which is the wrong shape for messages. Forcing a chat through it
 * means inventing step numbers and fighting the connector lines.
 */

import { Link } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  ChevronRight,
  File,
  Image,
  PanelRightClose,
  PanelRightOpen,
  X,
} from 'lucide-react'

import type {
  ActionFailure,
  ConversationDetail,
  ReplyDraftOutcome,
  ReplyGoalCheck,
} from '#/lib/gmail/service.ts'
import type { ReplyAttachmentUpload } from '#/lib/gmail/send.ts'
import type { SenderProfileSettings } from '#/lib/conversation/index.ts'
import type { ConversationState } from '#/db/schema.ts'
import { isRichHtml } from '#/lib/mail/rich.ts'
import { dedupeMediaByHash, sha256Hex } from '#/lib/mail/media.ts'
import type {
  ContactContextFields,
  ContactContextTextFields,
} from '#/lib/contacts/context.ts'

import { Avatar } from '#/components/avatar'
import { StateBadge } from '#/components/state-badge'
import { DONE_META, READ_META, STATE_ORDER } from '#/lib/conversation-state'
import { cn } from '#/lib/utils'

/**
 * Render one message body.
 *
 * Email HTML is a foreign layout language: fixed 600px tables, inline styles,
 * its own fonts. Injected into the app's DOM it escapes the bubble, inherits
 * nothing, and its `position: absolute` rules can cover the composer. So it goes
 * into a sandboxed iframe instead, where it renders in its own document exactly
 * as the sender designed it.
 *
 * The sandbox grants `allow-same-origin` but deliberately *not* `allow-scripts`:
 * the sanitiser already removed scripts and handlers, and withholding script
 * permission means a sanitiser bypass still cannot execute anything. Same-origin
 * is what lets the parent measure the content height to size the frame.
 *
 * The frame is only used for mail that actually uses layout (`isRichHtml`). Every
 * `multipart/alternative` message has an HTML part, and most are just the same
 * sentences in a `<div>` — rendering those in their own document gave the chat a
 * white box with foreign fonts and margins for what should have been a normal
 * bubble.
 */
function MessageBody({
  html,
  text,
  mine,
}: {
  html: string | null
  text: string
  mine: boolean
}) {
  // Incoming mail gets the wider measure: it is the thing being read, and a
  // bubble sized for a short chat reply was narrowing every newsletter and
  // invoice to a column that email layouts were never drawn for. What the user
  // sent stays narrow, because it is a reply rather than the content itself.
  const base = cn(
    'rounded-lg border text-sm',
    mine ? 'max-w-[88%] sm:max-w-[80%]' : 'max-w-full sm:max-w-[92%]',
  )
  const tone = mine
    ? 'border-primary/20 bg-primary/10 text-foreground'
    : 'border-border bg-card text-card-foreground'

  // Rich mail fills the bubble edge to edge: the sender's own padding would
  // otherwise sit inside ours and read as a stray white inset. Incoming rich
  // mail also takes the full column, since its fixed-width tables would
  // otherwise be clipped by the chat measure.
  if (isRichHtml(html)) {
    return (
      <div className={cn(base, tone, 'overflow-hidden p-0', !mine && 'w-full')}>
        <EmailFrame html={html as string} />
      </div>
    )
  }

  return (
    <div className={cn(base, tone, 'px-3 py-2')}>
      <span className="whitespace-pre-wrap">{text}</span>
    </div>
  )
}

/**
 * A sandboxed document sized to its content.
 *
 * Height is measured after load and on every resize, because email bodies reflow
 * as images finish loading — a fixed height would either clip the message or
 * leave a large empty gap under it.
 */
function EmailFrame({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(0)

  useEffect(() => {
    const el = frame.current
    if (!el) return

    const measure = () => {
      const body = el.contentDocument?.body
      if (!body) return

      setHeight(Math.ceil(body.scrollHeight))
    }

    el.addEventListener('load', measure)

    // Also observe from the parent: images decode after `load`, and a body with
    // no text (a single tracking-sized image) reports 0 until they do.
    const observer = new ResizeObserver(measure)
    observer.observe(el)

    return () => {
      el.removeEventListener('load', measure)
      observer.disconnect()
    }
  }, [html])

  // A default browser body has an 8px margin, which showed up as a white inset
  // inside the bubble. Reset only the edge, so the sender's own styles win
  // everywhere else.
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style></head><body>${html}</body></html>`

  return (
    <iframe
      ref={frame}
      title="Email content"
      srcDoc={srcDoc}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      loading="lazy"
      className="block w-full border-0 bg-white"
      style={{ height: height > 0 ? `${height}px` : '24px' }}
    />
  )
}

/**
 * The user's own "I have dealt with this" mark.
 *
 * A button rather than something inferred, because inferring it is the exact
 * failure it exists to prevent: opening a thread — or even replying into it and
 * waiting on an answer — is not the same as having finished with it, and a thread
 * that quietly marks itself done is one nobody comes back to. Two labels, one
 * control, like the state button; the mark leaves the state alone, so the thread
 * stays where the decision layer put it.
 */
function DoneButton({
  done,
  onSet,
}: {
  done: boolean
  onSet: (done: boolean) => Promise<{ error: string | null }>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await onSet(!done)
      if (result.error) setError(result.error)
    } catch {
      setError('Could not update this conversation.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        title={
          done
            ? 'Reopen: this thread counts as work again'
            : 'Mark done: you have dealt with this thread. New mail brings it back by itself.'
        }
        className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:border-foreground/25 disabled:opacity-50"
      >
        {/* "Mark done" rather than "Done": one is the action, the other is the
            state, and a button that reads like a label is how a control gets
            mistaken for a badge. */}
        {busy
          ? done
            ? 'Reopening…'
            : 'Marking…'
          : done
            ? 'Reopen'
            : 'Mark done'}
      </button>
      {error ? (
        <span
          role="alert"
          className="max-w-48 text-right text-xs text-destructive"
        >
          {error}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The user's own label for a thread.
 *
 * A picker rather than the single "Not important" button it replaces. That button
 * existed for one case — stop showing me this — and the state it set is the same
 * four labels the list groups by, so there was never a reason to offer one of
 * them and not the others: a thread the app filed as informational that is
 * actually work, or one it called work that is not, are the same correction in
 * opposite directions.
 *
 * **Automatic** is the app's own answer, and the honest default: it is what the
 * unmarked state means, so a thread the decision layer put where the user would
 * have put it still reads as unmarked. Choosing it hands the thread back — the
 * stored label is cleared and the pipeline re-runs — which is also how the "stop
 * ranking this sender low" lesson is undone.
 */
function StateLabelPicker({
  current,
  labels,
  onSet,
}: {
  /** The stored label, or null when the app's own answer stands. */
  current: ConversationState | null
  /** The user's wording for each label; the defaults when they left them. */
  labels: ConversationDetail['stateLabels']
  onSet: (state: ConversationState | null) => Promise<{ error: string | null }>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // `''` is the DOM's "no value" for a select, and it is the identity of
  // Automatic here rather than a magic string to translate at the edges.
  const value = current ?? ''

  async function choose(next: string) {
    if (busy || next === value) return
    setBusy(true)
    setError(null)
    try {
      const result = await onSet(
        next === '' ? null : (next as ConversationState),
      )
      if (result.error) setError(result.error)
    } catch {
      setError('Could not change the label.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <label
        className="flex items-center gap-2 text-xs text-muted-foreground"
        title="Where this thread is filed. Automatic is the app's own answer; picking a label overrides it for this thread."
      >
        Label
        <select
          value={value}
          onChange={(event) => void choose(event.target.value)}
          disabled={busy}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground disabled:opacity-50"
        >
          <option value="">Automatic</option>
          {STATE_ORDER.map((state) => (
            <option key={state} value={state}>
              {labels[state].name}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <span
          role="alert"
          className="max-w-48 text-right text-xs text-destructive"
        >
          {error}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The user's own score for a thread.
 *
 * A picker rather than a read-only number, because importance is the one score
 * that decides both where the thread sits in the list and whether a draft is
 * worth offering — and only the user knows their own priorities. **Automatic**
 * names the app's number so handing it back is a visible choice rather than an
 * empty option.
 */
function ImportancePicker({
  current,
  effective,
  onSet,
}: {
  /** The stored score, or null when the decision layer's number stands. */
  current: number | null
  /** The number on screen and in the sort, override included. */
  effective: number
  onSet: (importance: number | null) => Promise<{ error: string | null }>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const value = current === null ? '' : String(current)

  async function choose(next: string) {
    if (busy || next === value) return
    setBusy(true)
    setError(null)
    try {
      const result = await onSet(next === '' ? null : Number(next))
      if (result.error) setError(result.error)
    } catch {
      setError('Could not change the importance.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <label
        className="flex items-center gap-2 text-xs text-muted-foreground"
        title="How much this thread needs you. Automatic is the app's own score; a number you pick stays on this thread until newer mail arrives."
      >
        Importance
        <select
          value={value}
          onChange={(event) => void choose(event.target.value)}
          disabled={busy}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground disabled:opacity-50"
        >
          <option value="">Automatic ({effective}/10)</option>
          {Array.from({ length: 10 }, (_, index) => index + 1).map((score) => (
            <option key={score} value={score}>
              {score}/10
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <span className="max-w-48 text-xs text-destructive">{error}</span>
      ) : null}
    </div>
  )
}

/**
 * Mark this thread's sender as one a reply cannot reach.
 *
 * The quick end of the can't-reply list: the address and the mailbox are both
 * already known here, so the whole gesture is one click — and the composer below
 * is what confirms it, because the reply box is gone the moment the loader comes
 * back. The undo deliberately lives only in Settings, where the list is managed,
 * so this stays a second way to *add* an entry rather than a second place the
 * mark is edited.
 */
function CantReplyButton({
  senderEmail,
  onMark,
}: {
  senderEmail: string
  onMark: () => Promise<{ error: string | null }>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await onMark()
      if (result.error) setError(result.error)
    } catch {
      setError('Could not mark this sender.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        title={`Hide the reply box on every thread from ${senderEmail}. Undo this from the can’t-reply list in Settings.`}
        className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
      >
        {busy ? 'Marking…' : 'Can’t reply'}
      </button>
      {error ? (
        <span
          role="alert"
          className="max-w-48 text-right text-xs text-destructive"
        >
          {error}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Re-run the decision layer for this thread.
 *
 * Kept out of the header's action row on purpose: it overwrites the stored
 * label, importance and urgency with a fresh decision, so sitting beside "Mark
 * done" it was one misclick away from undoing a label the user had chosen. It
 * lives in Thread details and asks once before replacing anything.
 */
function ReanalyseButton({
  onReanalyse,
}: {
  onReanalyse: () => Promise<{ error: string | null }>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  async function run() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await onReanalyse()
      if (result.error) setError(result.error)
      else setConfirming(false)
    } catch {
      setError('Could not re-analyse this conversation.')
    } finally {
      setBusy(false)
    }
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-start gap-1">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted"
        >
          Re-analyse
        </button>
        <p className="text-[11px] text-muted-foreground">
          Replaces this thread’s label and importance with a new decision.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-[11px] text-foreground">
        Re-analyse this thread? Its current label and importance will be
        replaced.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive disabled:opacity-50"
        >
          {busy ? 'Re-analysing…' : 'Re-analyse'}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false)
            setError(null)
          }}
          disabled={busy}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  )
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function dayLabel(iso: string): string {
  const date = new Date(iso)
  const today = new Date()

  if (date.toDateString() === today.toDateString()) return 'Today'
  if (
    date.toDateString() ===
    new Date(today.getTime() - 86_400_000).toDateString()
  ) {
    return 'Yesterday'
  }

  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
}

function formatBytes(bytes: number): string {
  // Gmail reports no size for some parts; "0 B" reads like a broken file, while
  // an unknown size simply says nothing.
  if (bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Where the bytes of one attachment are served from.
 *
 * The attachment id is only unique inside its thread, and an id is not a path
 * segment until it is encoded — Gmail's ids are base64url, so they can contain
 * `-` and `_` but also `/` in the general case.
 */
function attachmentHref(
  fallbackThreadId: string,
  file: ConversationDetail['attachments'][number],
): string {
  const thread = new URLSearchParams({
    thread: file.providerThreadId || fallbackThreadId,
  })
  return `/attachments/${encodeURIComponent(file.providerAttachmentId)}?${thread}`
}

type MediaAttachment = ConversationDetail['attachments'][number]

function MediaOverview({
  attachments,
  providerThreadId,
  id,
  onClose,
  hashFailures,
  checking,
}: {
  attachments: MediaAttachment[]
  providerThreadId: string
  id: string
  onClose?: () => void
  hashFailures: number
  checking: boolean
}) {
  return (
    <>
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-4">
        <div className="min-w-0">
          <h2 className="font-semibold text-foreground">Thread media</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {attachments.length} {attachments.length === 1 ? 'file' : 'files'}{' '}
            across this conversation
            {checking ? ' · Checking repeated media…' : ''}
          </p>
          {hashFailures > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {hashFailures} {hashFailures === 1 ? 'media file' : 'media files'}{' '}
              could not be checked and remain listed.
            </p>
          ) : null}
        </div>
        {onClose ? (
          <button
            type="button"
            aria-label="Close media and attachments"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </header>
      <ul id={id} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {attachments.map((attachment) => {
          const image = attachment.mimeType.startsWith('image/')
          const href = attachmentHref(providerThreadId, attachment)
          const sender = attachment.sender
          const sentAt = attachment.sentAt

          return (
            <li
              key={`${attachment.providerMessageId}:${attachment.providerAttachmentId}`}
            >
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                title={`Open ${attachment.filename}`}
                className="group block overflow-hidden rounded-lg border border-border bg-background transition-colors hover:border-foreground/30"
              >
                {image ? (
                  <img
                    src={href}
                    alt={attachment.filename}
                    loading="lazy"
                    className="max-h-40 w-full bg-muted/30 object-contain"
                  />
                ) : null}
                <div className="flex items-start gap-2.5 p-3">
                  <span className="mt-0.5 rounded-md bg-muted p-1.5 text-muted-foreground">
                    {image ? (
                      <Image className="size-4" />
                    ) : (
                      <File className="size-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground group-hover:underline">
                      {attachment.filename}
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {attachment.mimeType}
                      {formatBytes(attachment.sizeBytes)
                        ? ` · ${formatBytes(attachment.sizeBytes)}`
                        : ''}
                    </span>
                    {sender && sentAt ? (
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {sender.name ?? sender.email} · {formatTime(sentAt)}
                      </span>
                    ) : null}
                    {attachment.isInline ? (
                      <span className="mt-1 block text-[10px] text-muted-foreground/80">
                        Inline media
                      </span>
                    ) : null}
                  </span>
                </div>
              </a>
            </li>
          )
        })}
      </ul>
    </>
  )
}

function ContactContextEditor({
  email,
  initialContext,
  onSave,
  onSuggest,
}: {
  email: string
  initialContext: ConversationDetail['contactContext']
  onSave: (context: ContactContextFields) => Promise<{ error: string | null }>
  onSuggest: (current: ContactContextTextFields) => Promise<{
    suggestion: ContactContextTextFields | null
    error: string | null
  }>
}) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiSuggested, setAiSuggested] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roleCompany, setRoleCompany] = useState(
    initialContext?.roleCompany ?? '',
  )
  const [relationship, setRelationship] = useState(
    initialContext?.relationship ?? '',
  )
  const [topics, setTopics] = useState(initialContext?.topics ?? '')
  const [currentWork, setCurrentWork] = useState(
    initialContext?.currentWork ?? '',
  )
  const [importance, setImportance] = useState<number | null>(
    initialContext?.importance ?? null,
  )

  useEffect(() => {
    setRoleCompany(initialContext?.roleCompany ?? '')
    setRelationship(initialContext?.relationship ?? '')
    setTopics(initialContext?.topics ?? '')
    setCurrentWork(initialContext?.currentWork ?? '')
    setImportance(initialContext?.importance ?? null)
    setEditing(false)
    setAiSuggested(false)
    setError(null)
  }, [initialContext, email])

  async function suggest() {
    if (busy || aiBusy) return
    setAiBusy(true)
    setError(null)
    try {
      const result = await onSuggest({
        roleCompany,
        relationship,
        topics,
        currentWork,
      })
      if (result.error || !result.suggestion) {
        setError(result.error ?? 'Could not generate contact context.')
      } else {
        setRoleCompany(result.suggestion.roleCompany)
        setRelationship(result.suggestion.relationship)
        setTopics(result.suggestion.topics)
        setCurrentWork(result.suggestion.currentWork)
        setAiSuggested(true)
      }
    } catch {
      setError('Could not generate contact context.')
    } finally {
      setAiBusy(false)
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await onSave({
        roleCompany,
        relationship,
        topics,
        currentWork,
        importance,
      })
      if (result.error) {
        setError(result.error)
      } else {
        setEditing(false)
      }
    } catch {
      setError('Could not save this contact profile.')
    } finally {
      setBusy(false)
    }
  }

  const hasContext = Boolean(
    initialContext?.roleCompany ||
    initialContext?.relationship ||
    initialContext?.topics ||
    initialContext?.currentWork ||
    (initialContext?.importance !== null &&
      initialContext?.importance !== undefined),
  )

  return (
    <section className="border-b border-border bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-foreground">
            About this person
          </h2>
          <p className="truncate text-xs text-muted-foreground">{email}</p>
        </div>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted"
          >
            {hasContext ? 'Edit context' : 'Add context'}
          </button>
        ) : null}
      </div>
      {editing ? (
        <form className="mt-3 space-y-2" onSubmit={(event) => void save(event)}>
          <label className="block text-xs text-muted-foreground">
            Role / company
            <input
              value={roleCompany}
              onChange={(event) => setRoleCompany(event.target.value)}
              maxLength={160}
              placeholder="CEO of Acme"
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground/30"
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            Importance to you (1–10)
            <select
              value={importance === null ? '' : String(importance)}
              onChange={(event) =>
                setImportance(
                  event.target.value ? Number(event.target.value) : null,
                )
              }
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground/30"
            >
              <option value="">Not rated</option>
              {Array.from({ length: 10 }, (_, index) => index + 1).map(
                (score) => (
                  <option key={score} value={score}>
                    {score}/10
                    {score === 10
                      ? ' · Very important'
                      : score === 1
                        ? ' · Low importance'
                        : ''}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="block text-xs text-muted-foreground">
            Relationship
            <textarea
              value={relationship}
              onChange={(event) => setRelationship(event.target.value)}
              maxLength={500}
              rows={2}
              placeholder="How you know or work with them"
              className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground/30"
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            Topics discussed
            <textarea
              value={topics}
              onChange={(event) => setTopics(event.target.value)}
              maxLength={1000}
              rows={2}
              placeholder="Partnership, hiring, product launch…"
              className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground/30"
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            Currently working on
            <textarea
              value={currentWork}
              onChange={(event) => setCurrentWork(event.target.value)}
              maxLength={1000}
              rows={2}
              placeholder="Current projects or priorities"
              className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground/30"
            />
          </label>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {aiSuggested ? (
            <p className="text-xs text-muted-foreground">
              AI suggestions are unsaved. Review and edit them before saving.
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={busy || aiBusy}
              onClick={() => void suggest()}
              className="mr-auto rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-muted disabled:opacity-50"
            >
              {aiBusy ? 'Suggesting…' : 'Suggest with AI'}
            </button>
            <button
              type="button"
              disabled={busy || aiBusy}
              onClick={() => {
                setRoleCompany(initialContext?.roleCompany ?? '')
                setRelationship(initialContext?.relationship ?? '')
                setTopics(initialContext?.topics ?? '')
                setCurrentWork(initialContext?.currentWork ?? '')
                setImportance(initialContext?.importance ?? null)
                setEditing(false)
                setAiSuggested(false)
                setError(null)
              }}
              className="rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || aiBusy}
              className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save context'}
            </button>
          </div>
        </form>
      ) : hasContext ? (
        <>
          {initialContext?.importance !== null &&
          initialContext?.importance !== undefined ? (
            <span
              title="Your importance rating for this correspondent; used as context when classifying their mail."
              className="mt-2 inline-flex rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
            >
              Contact importance · {initialContext.importance}/10
            </span>
          ) : null}
          <dl className="mt-3 space-y-2 text-sm">
            {[
              ['Role / company', initialContext?.roleCompany],
              ['Relationship', initialContext?.relationship],
              ['Topics discussed', initialContext?.topics],
              ['Currently working on', initialContext?.currentWork],
            ].map(([label, value]) =>
              value ? (
                <div key={label}>
                  <dt className="text-[10px] font-medium text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="whitespace-pre-wrap text-xs text-foreground">
                    {value}
                  </dd>
                </div>
              ) : null,
            )}
          </dl>
        </>
      ) : initialContext?.importance !== null &&
        initialContext?.importance !== undefined ? (
        <>
          <span className="mt-2 inline-flex rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            Contact importance · {initialContext.importance}/10
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="ml-2 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted"
          >
            Edit context
          </button>
        </>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Add private notes or ask AI for a draft based on this thread. Review
          suggestions before saving.
        </p>
      )}
    </section>
  )
}

function ParsingProfileEditor({
  profile,
  onSave,
}: {
  profile: NonNullable<ConversationDetail['parsingProfile']>
  onSave: (profile: SenderProfileSettings) => Promise<{ error: string | null }>
}) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [useAccountParsingDefaults, setUseAccountParsingDefaults] = useState(
    profile.useAccountParsingDefaults,
  )
  const [stripQuotedHistory, setStripQuotedHistory] = useState(
    profile.stripQuotedHistory,
  )
  const [stripGreeting, setStripGreeting] = useState(profile.stripGreeting)
  const [stripSignature, setStripSignature] = useState(profile.stripSignature)
  const [replyStyleEnabled, setReplyStyleEnabled] = useState(
    profile.replyStyleEnabled,
  )
  const [replyGreeting, setReplyGreeting] = useState(profile.replyGreeting)
  const [replySignature, setReplySignature] = useState(profile.replySignature)

  useEffect(() => {
    setUseAccountParsingDefaults(profile.useAccountParsingDefaults)
    setStripQuotedHistory(profile.stripQuotedHistory)
    setStripGreeting(profile.stripGreeting)
    setStripSignature(profile.stripSignature)
    setReplyStyleEnabled(profile.replyStyleEnabled)
    setReplyGreeting(profile.replyGreeting)
    setReplySignature(profile.replySignature)
  }, [profile])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await onSave({
        useAccountParsingDefaults,
        stripQuotedHistory,
        stripGreeting,
        stripSignature,
        replyStyleEnabled,
        replyGreeting: replyStyleEnabled ? replyGreeting : null,
        replySignature: replyStyleEnabled ? replySignature : null,
      })
      if (result.error) setError(result.error)
      else setEditing(false)
    } catch {
      setError('Could not save parsing preferences. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="mt-2 text-xs font-medium text-primary hover:underline"
      >
        Tune parsing & reply style for {profile.senderEmail}
      </button>
    )
  }

  function toggle(
    label: string,
    checked: boolean,
    setChecked: (value: boolean) => void,
  ) {
    return (
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
        />
        Strip {label} from this sender
      </label>
    )
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="mt-3 space-y-3 rounded-md border border-border bg-muted/20 p-3"
    >
      <p className="text-xs font-medium text-foreground">
        What Nuntia removes from {profile.senderEmail}
      </p>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={useAccountParsingDefaults}
          onChange={(event) =>
            setUseAccountParsingDefaults(event.target.checked)
          }
        />
        Use account-wide parsing defaults
      </label>
      {!useAccountParsingDefaults ? (
        <div className="space-y-2 rounded-md bg-background/60 p-2">
          {toggle('quoted history', stripQuotedHistory, setStripQuotedHistory)}
          {toggle('greetings', stripGreeting, setStripGreeting)}
          {toggle('signatures', stripSignature, setStripSignature)}
        </div>
      ) : null}
      <div className="border-t border-border pt-3">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={replyStyleEnabled}
            onChange={(event) => setReplyStyleEnabled(event.target.checked)}
          />
          Use a different greeting and signature for this sender
        </label>
        {replyStyleEnabled ? (
          <>
            <label className="mt-2 block text-xs text-muted-foreground">
              Greeting for this sender
              <input
                value={replyGreeting}
                maxLength={200}
                onChange={(event) => setReplyGreeting(event.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              />
            </label>
            <label className="mt-2 block text-xs text-muted-foreground">
              Signature for this sender
              <textarea
                value={replySignature}
                maxLength={1000}
                rows={2}
                onChange={(event) => setReplySignature(event.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              />
            </label>
          </>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save & re-parse this sender'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setEditing(false)}
          className="rounded-md border border-border px-3 py-1.5 text-xs"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

function StrippedParts({
  message,
}: {
  message: ConversationDetail['messages'][number]
}) {
  const parts = [
    ['Greeting', message.strippedGreeting],
    ['Signature', message.strippedSignature],
    ['Quoted history', message.strippedQuote],
  ].filter((part): part is [string, string] => Boolean(part[1]))
  if (parts.length === 0) return null
  return (
    <details className="max-w-[80%] text-xs text-muted-foreground">
      <summary className="cursor-pointer">View text removed by parsing</summary>
      <div className="mt-1 space-y-2 rounded-md border border-border bg-muted/20 p-2">
        {parts.map(([label, content]) => (
          <div key={label}>
            <p className="font-medium">{label}</p>
            <pre className="whitespace-pre-wrap font-sans">{content}</pre>
          </div>
        ))}
      </div>
    </details>
  )
}

function ConversationDetailsEditor({
  topic,
  goal,
  onSave,
}: {
  topic: string | null
  goal: string | null
  onSave: (
    topic: string | null,
    goal: string | null,
  ) => Promise<{ error: string | null }>
}) {
  const [editing, setEditing] = useState(false)
  const [draftTopic, setDraftTopic] = useState(topic ?? '')
  const [draftGoal, setDraftGoal] = useState(goal ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    setBusy(true)
    setError(null)
    try {
      const result = await onSave(
        draftTopic.trim() || null,
        draftGoal.trim() || null,
      )
      if (result.error) {
        setError(result.error)
      } else {
        setEditing(false)
      }
    } catch {
      setError('Could not save conversation details. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <form onSubmit={(event) => void submit(event)} className="mt-3 space-y-2">
        <label className="block text-xs text-muted-foreground">
          Topic
          <input
            value={draftTopic}
            onChange={(event) => setDraftTopic(event.target.value)}
            maxLength={120}
            placeholder="Add a topic"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </label>
        <label className="block text-xs text-muted-foreground">
          Goal
          <textarea
            value={draftGoal}
            onChange={(event) => setDraftGoal(event.target.value)}
            maxLength={500}
            rows={2}
            placeholder="What do you want to achieve in this conversation?"
            className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </label>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save details'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraftTopic(topic ?? '')
              setDraftGoal(goal ?? '')
              setError(null)
              setEditing(false)
            }}
            className="rounded-md border border-border px-3 py-1.5 text-xs"
          >
            Cancel
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1 text-xs">
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">Topic:</span>{' '}
        {topic || 'Not set'}
      </p>
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">Goal:</span>{' '}
        {goal || 'Not set'}
      </p>
      <button
        type="button"
        onClick={() => {
          setDraftTopic(topic ?? '')
          setDraftGoal(goal ?? '')
          setError(null)
          setEditing(true)
        }}
        className="font-medium text-primary hover:underline"
      >
        Edit details
      </button>
    </div>
  )
}

/**
 * The composer.
 *
 * Only rendered for threads with a human on the other side — a reply box on a
 * `noreply@` notification is a promise the app cannot keep.
 */
function Composer({
  accounts,
  provider,
  suggest,
  onDraft,
  onSend,
  onReviewReply,
}: {
  /** Addresses this reply could leave from, best first. */
  accounts: Array<{ id: string; email: string }>
  /** Which service the owning mailbox uses, for the reconnect link. */
  provider: ConversationDetail['provider']
  /** Whether a draft can be generated, and why not when it cannot. */
  suggest: ConversationDetail['suggestReply']
  /** Generate one draft. Never sends: the result lands in this box. */
  onDraft: (instructions: string | null) => Promise<ReplyDraftOutcome>
  onSend: (
    body: string,
    attachments: ReplyAttachmentUpload[],
    fromAccountId: string,
  ) => Promise<ActionFailure>
  /** Judge the reply just sent against the thread's goal. Never blocks a send. */
  onReviewReply: (body: string) => Promise<{
    check: ReplyGoalCheck | null
    error: string | null
  }>
}) {
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<ReplyAttachmentUpload[]>([])
  // Defaults to the owning mailbox; the user can change it when the thread
  // carries more than one of their addresses.
  const [fromAccountId, setFromAccountId] = useState(accounts[0]?.id ?? '')
  const [readingFiles, setReadingFiles] = useState(false)
  const filePicker = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set when the failure was Google rejecting the stored grant. A retry cannot
  // fix that, so the composer offers the one action that can.
  const [authRequired, setAuthRequired] = useState(false)
  // The send has already happened by the time any of this exists, so it is
  // advice in a box rather than a state the reply is waiting on.
  const [goalCheck, setGoalCheck] = useState<ReplyGoalCheck | null>(null)
  const [reviewingGoal, setReviewingGoal] = useState(false)
  const [goalError, setGoalError] = useState<string | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)

  // Grow to fit, up to a cap, so a long reply does not scroll in a tiny box.
  useEffect(() => {
    const el = textarea.current
    if (!el) return

    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [body])

  /** Ask whether the reply just sent reaches the goal, without delaying the send. */
  async function reviewGoal(sentBody: string) {
    setReviewingGoal(true)
    setGoalError(null)
    try {
      const result = await onReviewReply(sentBody)
      if (result.error) {
        setGoalError(result.error)
        return
      }
      setGoalCheck(result.check)
    } catch {
      setGoalError('Could not check that reply against your goal.')
    } finally {
      setReviewingGoal(false)
    }
  }

  async function submit() {
    const trimmed = body.trim()
    if ((!trimmed && attachments.length === 0) || busy || readingFiles) return

    setBusy(true)
    setError(null)
    setAuthRequired(false)

    try {
      const result = await onSend(trimmed, attachments, fromAccountId)

      if (result.error) {
        setError(result.error)
        setAuthRequired(result.authRequired)
      } else {
        // Cleared only on success, so a failed send never discards the reply.
        setBody('')
        setAttachments([])
        if (filePicker.current) filePicker.current.value = ''
        setGoalCheck(null)
        setGoalError(null)
        // After the send, never before it: the message is already on its way, so
        // this can only ever add advice to a reply that went out.
        void reviewGoal(trimmed)
      }
    } catch {
      setError('Could not send the reply. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return

    setError(null)
    // An attachment problem is not an auth problem, so a stale Reconnect
    // action must not linger beside this error.
    setAuthRequired(false)
    setReadingFiles(true)
    try {
      const selected = Array.from(files)
      if (attachments.length + selected.length > 10) {
        setError('Attach no more than 10 files per reply.')
        return
      }

      const currentBytes = attachments.reduce(
        (total, file) => total + Math.floor((file.data.length * 3) / 4),
        0,
      )
      const added: ReplyAttachmentUpload[] = []
      let totalBytes = currentBytes

      for (const file of selected) {
        if (file.size === 0) {
          setError(`${file.name} is empty and cannot be attached.`)
          return
        }
        if (file.size > 25 * 1024 * 1024) {
          setError(`${file.name} exceeds the 25 MB per-file limit.`)
          return
        }
        totalBytes += file.size
        if (totalBytes > 18 * 1024 * 1024) {
          setError('Attachments must total 18 MB or less.')
          return
        }

        const bytes = new Uint8Array(await file.arrayBuffer())
        added.push({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          data: encodeFileBytes(bytes),
        })
      }

      setAttachments((current) => [...current, ...added])
    } catch {
      setError('Could not read the selected attachment.')
    } finally {
      setReadingFiles(false)
      if (filePicker.current) filePicker.current.value = ''
    }
  }

  return (
    <div className="border-t border-border bg-card p-3 sm:p-4">
      {error ? (
        <div
          role="alert"
          className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <p>{error}</p>
          {authRequired ? (
            <a
              href={
                provider === 'microsoft' ? '/auth/microsoft' : '/auth/google'
              }
              className={cn(
                'mt-3 inline-flex h-8 items-center rounded-md bg-primary px-3',
                'text-xs font-medium text-primary-foreground',
              )}
            >
              Reconnect {provider === 'microsoft' ? 'Outlook' : 'Gmail'}
            </a>
          ) : null}
        </div>
      ) : null}

      {reviewingGoal ? (
        <p className="mb-2 text-[11px] text-muted-foreground">
          Checking that reply against your goal…
        </p>
      ) : null}

      {goalCheck ? (
        <div className="mb-2 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="text-[11px] font-semibold tracking-wide text-warning uppercase">
            That reply may not reach your goal
          </p>
          {goalCheck.reason ? (
            <p className="mt-1 text-xs text-foreground">{goalCheck.reason}</p>
          ) : null}
          {goalCheck.suggestion ? (
            <>
              <p className="mt-2 text-[11px] text-muted-foreground">
                A follow-up you could send
              </p>
              <p className="mt-1 text-sm whitespace-pre-wrap text-foreground">
                {goalCheck.suggestion}
              </p>
            </>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {goalCheck.suggestion ? (
              <button
                type="button"
                onClick={() => {
                  setBody(goalCheck.suggestion ?? '')
                  setGoalCheck(null)
                  textarea.current?.focus()
                }}
                className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground"
              >
                Use this reply
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setGoalCheck(null)}
              className="text-[11px] text-muted-foreground hover:underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {goalError ? (
        <p role="alert" className="mb-2 text-[11px] text-muted-foreground">
          {goalError}
        </p>
      ) : null}

      <SuggestedReply
        suggest={suggest}
        onDraft={onDraft}
        // The composer's own state is the destination: a draft is text in the
        // box the user reviews, which is what keeps "use" from ever meaning
        // "send".
        onUseDraft={(draft) => {
          setBody(draft)
          textarea.current?.focus()
        }}
      />

      <textarea
        ref={textarea}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter breaks the line — the convention every
          // chat UI shares, and the opposite of a plain textarea.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
          }
        }}
        rows={1}
        placeholder="Write a reply…"
        className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/30"
      />

      {attachments.length > 0 ? (
        <ul
          className="mt-2 flex flex-wrap gap-2"
          aria-label="Attachments to send"
        >
          {attachments.map((attachment, index) => (
            <li
              key={`${attachment.filename}-${index}`}
              className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
            >
              <span className="max-w-56 truncate">{attachment.filename}</span>
              <button
                type="button"
                aria-label={`Remove ${attachment.filename}`}
                disabled={busy}
                onClick={() =>
                  setAttachments((current) =>
                    current.filter((_, i) => i !== index),
                  )
                }
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <input
        ref={filePicker}
        type="file"
        multiple
        className="hidden"
        aria-label="Choose attachments"
        onChange={(event) => void addFiles(event.target.files)}
      />

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {/* Only offered when there is a choice: a single-account install
              should not see a one-option dropdown on every reply. */}
          {accounts.length > 1 ? (
            <label className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              From
              <select
                value={fromAccountId}
                disabled={busy}
                onChange={(event) => setFromAccountId(event.target.value)}
                className="max-w-[11rem] rounded-md border border-border bg-background px-1.5 py-0.5 text-xs text-foreground sm:max-w-none"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.email}
                  </option>
                ))}
              </select>
            </label>
          ) : accounts.length === 1 ? (
            <span className="text-xs text-muted-foreground">
              From {accounts[0]?.email}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => filePicker.current?.click()}
            disabled={busy || readingFiles || attachments.length >= 10}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {readingFiles ? 'Adding…' : 'Attach files'}
          </button>
          {/* A keyboard hint on a touch screen is noise, and it was what pushed
              the send button off the row on a phone. */}
          <span className="hidden text-xs text-muted-foreground sm:inline">
            Enter to send · Shift+Enter for a new line
          </span>
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={
            busy ||
            readingFiles ||
            (body.trim().length === 0 && attachments.length === 0)
          }
          className={cn(
            'rounded-md bg-primary px-3 py-1.5 text-sm font-medium',
            'text-primary-foreground disabled:opacity-50',
          )}
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

/**
 * The suggested reply: a draft the model wrote, and the two ways to take it.
 *
 * Renders nothing at all on an install with no LLM key — the feature is simply
 * off there, and a line about it above every reply box would be noise. With a
 * model configured it always accounts for itself: either the button, or the one
 * condition that failed, using the same facts the server gates on.
 *
 * Neither action sends. `Edit` opens the draft for changes in place, `Use draft`
 * puts the current text into the composer below — where the user's own Send is
 * still the only thing that sends anything.
 */
function SuggestedReply({
  suggest,
  onDraft,
  onUseDraft,
}: {
  suggest: ConversationDetail['suggestReply']
  onDraft: (instructions: string | null) => Promise<ReplyDraftOutcome>
  onUseDraft: (draft: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function generate() {
    if (busy) return

    setBusy(true)
    setError(null)
    try {
      const result = await onDraft(instructions.trim() || null)
      if (result.error) {
        setError(result.error)
        return
      }
      setDraft(result.draft)
      setEditing(false)
    } catch {
      setError('Could not draft a reply.')
    } finally {
      setBusy(false)
    }
  }

  const buttonClass =
    'rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground disabled:opacity-50'

  // No key stored, and nothing drafted: the feature is off, not failing.
  if (!suggest.available && !suggest.reason && draft === null) return null

  if (!suggest.available && draft === null) {
    return (
      <p className="mb-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">No suggested reply.</span>{' '}
        {suggest.reason}
      </p>
    )
  }

  return (
    <div className="mb-2 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Suggested reply
        </h2>
        {draft !== null ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(null)
              setEditing(false)
              setError(null)
            }}
            className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Discard
          </button>
        ) : null}
      </div>

      {draft !== null ? (
        editing ? (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={5}
            aria-label="Edit the suggested reply"
            className="mt-2 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-foreground/30"
          />
        ) : (
          <p className="mt-2 text-sm whitespace-pre-wrap text-foreground">
            {draft}
          </p>
        )
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {busy
            ? 'Writing a draft…'
            : 'Drafts a reply from this thread for you to edit — nothing is sent until you send it.'}
        </p>
      )}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {draft !== null ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing((current) => !current)}
              className={buttonClass}
            >
              {editing ? 'Done editing' : 'Edit'}
            </button>
            <button
              type="button"
              disabled={busy || draft.trim().length === 0}
              onClick={() => {
                onUseDraft(draft.trim())
                setDraft(null)
                setEditing(false)
              }}
              className={cn(
                'rounded-md bg-primary px-2 py-1 text-xs font-medium',
                'text-primary-foreground disabled:opacity-50',
              )}
            >
              Use draft
            </button>
          </>
        ) : null}

        {/*
         * The instruction arrives *after* the first draft on purpose: asking for
         * one should be a single click, and "make it shorter" is something you
         * only know you want once you have read what it wrote.
         */}
        <input
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          disabled={busy}
          maxLength={500}
          placeholder="Add an instruction (optional)"
          className="min-w-48 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-foreground/30"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void generate()}
          className={buttonClass}
        >
          {busy ? 'Drafting…' : draft !== null ? 'Regenerate' : 'Draft a reply'}
        </button>
      </div>
    </div>
  )
}

/** Base64-encode bytes in chunks without overflowing argument limits. */
function encodeFileBytes(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + chunkSize, bytes.length),
    )
    for (const byte of chunk) binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export function ConversationView({
  detail,
  onSaveDetails,
  onSaveContactContext,
  onSuggestContactContext,
  onSaveParsingProfile,
  onSend,
  onReviewReply,
  onDraft,
  onReanalyse,
  onSetStateOverride,
  onSetImportance,
  onSetDone,
  onMarkSenderUnreplyable,
}: {
  detail: ConversationDetail
  onSaveContactContext: (
    context: ContactContextFields,
  ) => Promise<{ error: string | null }>
  onSuggestContactContext: (current: ContactContextTextFields) => Promise<{
    suggestion: ContactContextTextFields | null
    error: string | null
  }>
  onReanalyse: () => Promise<{ error: string | null }>
  /**
   * Generate a draft reply for this thread. The draft is returned, not stored,
   * and puts text in the composer — sending stays a separate, deliberate act.
   */
  onDraft: (instructions: string | null) => Promise<ReplyDraftOutcome>
  onSetStateOverride: (
    state: ConversationState | null,
  ) => Promise<{ error: string | null }>
  /** Set the user's own importance score, or null to let the app decide. */
  onSetImportance: (importance: number | null) => Promise<{
    error: string | null
  }>
  onSetDone: (done: boolean) => Promise<{ error: string | null }>
  /**
   * Add the thread's other party to the can't-reply list. Takes no arguments on
   * purpose: the server resolves the mailbox and the address from the thread, so
   * the caller cannot name a sender the thread is not.
   */
  onMarkSenderUnreplyable: () => Promise<{ error: string | null }>
  onSaveParsingProfile: (
    profile: SenderProfileSettings,
  ) => Promise<{ error: string | null }>
  onSaveDetails: (
    topic: string | null,
    goal: string | null,
  ) => Promise<{ error: string | null }>
  onSend: (
    body: string,
    attachments: ReplyAttachmentUpload[],
    fromAccountId: string,
  ) => Promise<ActionFailure>
  /** Judge the reply just sent against the thread's goal. */
  onReviewReply: (body: string) => Promise<{
    check: ReplyGoalCheck | null
    error: string | null
  }>
}) {
  const bottom = useRef<HTMLDivElement>(null)
  const [mediaOpen, setMediaOpen] = useState(false)
  const [dedupedMedia, setDedupedMedia] = useState<MediaAttachment[] | null>(
    null,
  )
  const [mediaHashFailures, setMediaHashFailures] = useState(0)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [detail.messages.length])

  // A thread between two of the user's own connected accounts has "mine" on both
  // sides, so `isFromOwner` cannot decide which bubble is which. The chat is
  // rendered from the owning mailbox's point of view: its messages are "You",
  // and messages from another connected address are the other side, labelled with
  // that address so the two are told apart.
  const ownerEmail = detail.accountId.trim().toLowerCase()
  const ownAddresses = new Set(
    detail.ownerEmails.map((email) => email.trim().toLowerCase()),
  )

  const messagesById = useMemo(
    () =>
      new Map(
        detail.messages.map((message) => [message.providerMessageId, message]),
      ),
    [detail.messages],
  )
  const attachmentsByMessage = useMemo(() => {
    const grouped = new Map<string, ConversationDetail['attachments']>()
    for (const attachment of detail.attachments) {
      const list = grouped.get(attachment.providerMessageId) ?? []
      list.push(attachment)
      grouped.set(attachment.providerMessageId, list)
    }
    return grouped
  }, [detail.attachments])
  const mediaCandidates = useMemo(
    () =>
      detail.attachments
        .filter((attachment) => {
          const type = attachment.mimeType.toLowerCase()
          return (
            type.startsWith('image/') ||
            type.startsWith('audio/') ||
            type.startsWith('video/')
          )
        })
        .map((attachment) => ({
          ...attachment,
          message: messagesById.get(attachment.providerMessageId),
        })),
    [detail.attachments, messagesById],
  )
  const otherAttachments = useMemo(
    () =>
      detail.attachments
        .filter((attachment) => {
          const type = attachment.mimeType.toLowerCase()
          return (
            !type.startsWith('image/') &&
            !type.startsWith('audio/') &&
            !type.startsWith('video/')
          )
        })
        .map((attachment) => ({
          ...attachment,
          message: messagesById.get(attachment.providerMessageId),
        })),
    [detail.attachments, messagesById],
  )

  // Keep every media item visible while hashes are being calculated; once
  // resolved, replace that provisional list with the content-deduped one.
  const mediaAttachments = dedupedMedia
    ? [...dedupedMedia, ...otherAttachments]
    : [...mediaCandidates, ...otherAttachments]
  const mediaCandidatesKey = useMemo(
    () =>
      mediaCandidates
        .map((item) => `${item.providerThreadId}:${item.providerAttachmentId}`)
        .join('|'),
    [mediaCandidates],
  )

  useEffect(() => {
    let cancelled = false

    if (mediaCandidates.length === 0) {
      setDedupedMedia([])
      setMediaHashFailures(0)
      return
    }

    setDedupedMedia(null)
    setMediaHashFailures(0)

    void dedupeMediaByHash(mediaCandidates, async (attachment) => {
      const href = attachmentHref(detail.providerThreadId, attachment)
      const response = await fetch(href, { credentials: 'same-origin' })
      if (!response.ok) {
        throw new Error(`Could not read media (${response.status}).`)
      }
      const bytes = await response.arrayBuffer()
      return sha256Hex(bytes)
    }).then(({ items, failedCount }) => {
      if (cancelled) return
      setDedupedMedia(items)
      setMediaHashFailures(failedCount)
    })

    return () => {
      cancelled = true
    }
  }, [detail.providerThreadId, mediaCandidates, mediaCandidatesKey])

  let lastDay = ''
  // `New messages` is drawn from the mark the loader sent, not from a fresh read:
  // the server records the same instant this page renders, and re-loading to see
  // it would erase the divider the moment it appeared.
  const seenAtMs = detail.seenAt ? Date.parse(detail.seenAt) : 0
  const isUnseen = (message: ConversationDetail['messages'][number]): boolean =>
    !message.isFromOwner && Date.parse(message.sentAt) > seenAtMs
  let shownUnseenBoundary = false

  // The header avatar belongs to the other party. In a thread between two of the
  // user's own addresses that is still "the other side", which is why the
  // owner's addresses are excluded rather than just taking the first entry.
  const senderContact =
    detail.participants.find(
      (p) => !detail.ownerEmails.includes(p.email.toLowerCase()),
    ) ?? detail.participants[0]

  // The overview only exists when there is contact context or media behind it,
  // which is also what decides whether the mobile control is offered.
  const hasOverview = mediaAttachments.length > 0 || Boolean(detail.senderEmail)

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-b border-border px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-start gap-3">
          <Avatar
            contact={senderContact}
            className="mt-0.5 size-8 text-[10px] sm:size-9 sm:text-xs"
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-foreground sm:text-lg">
              {detail.topic ?? detail.subject}
            </h1>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {detail.participants.map((p) => p.name ?? p.email).join(', ')}
            </p>
            {/*
             * The state, the done mark and replyability were three chips in two
             * rows; they are facts about the thread, not controls, so they read
             * as one quiet line under the subject.
             */}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              <StateBadge
                state={detail.state}
                label={detail.stateLabels[detail.state].name}
              />
              {detail.done ? <span>{DONE_META.label}</span> : null}
              {detail.replyable ? null : <span>no reply</span>}
            </div>
            {detail.goal ? (
              <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">Goal</span>{' '}
                {detail.goal}
              </p>
            ) : null}
          </div>
          {/*
           * Promoted to the title row: on a phone the overview is the only way
           * to reach the sender's context and their attachments, so it should be
           * found without scanning a row of low-emphasis controls.
           */}
          {hasOverview ? (
            <button
              type="button"
              aria-expanded={mediaOpen}
              aria-controls="thread-media-overview-mobile"
              onClick={() => setMediaOpen((open) => !open)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted lg:hidden"
            >
              {mediaOpen ? (
                <PanelRightClose className="size-3.5" />
              ) : (
                <PanelRightOpen className="size-3.5" />
              )}
              Overview
              {mediaAttachments.length > 0
                ? ` (${dedupedMedia ? mediaAttachments.length : detail.attachments.length})`
                : ''}
            </button>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          {/*
           * Always offered, and it reads as a statement of where the thread is
           * as well as a control: the picker shows the stored label, or
           * Automatic when the app's own answer stands — including when a
           * sender-level call of the user's is what put it there.
           */}
          <StateLabelPicker
            current={detail.stateOverride}
            labels={detail.stateLabels}
            onSet={onSetStateOverride}
          />
          <ImportancePicker
            current={detail.importanceOverride}
            effective={detail.importance}
            onSet={onSetImportance}
          />
          {/*
           * Adding to the can't-reply list was Settings-only, which meant
           * recognising a sender you already had open and then finding the
           * address again somewhere else to type it. It is offered here too, and
           * only while a reply box is still on screen: a sender who is already
           * unanswerable has nothing left to add, which is why the control
           * disappears rather than becoming an undo.
           *
           * Taking the mark back stays in Settings — one list, one place to
           * manage it. This is a second way in, not a second place it is edited.
           */}
          {detail.replyable && detail.senderEmail ? (
            <CantReplyButton
              senderEmail={detail.senderEmail}
              onMark={onMarkSenderUnreplyable}
            />
          ) : null}
          <DoneButton done={detail.done} onSet={onSetDone} />
        </div>
      </header>

      {/*
       * Says what the tag above means, in the one place with room for it: the two
       * marks are easy to confuse, and "you handled this, so it is out of the open
       * groups" is the difference in a sentence.
       */}
      {detail.done ? (
        <p className="border-y border-border bg-success/5 px-4 py-2 text-xs text-muted-foreground sm:px-6">
          <span className="font-medium text-success">{DONE_META.label}</span> —{' '}
          {DONE_META.detail}{' '}
          {/*
           * The one moment worth asking: the thread has just been handled, so
           * either the product helped or it got in the way, and the person knows
           * which. No modal, and it never interrupts the next thread.
           */}
          <Link
            to="/feedback"
            search={{ thread: detail.providerThreadId }}
            className="text-primary hover:underline"
          >
            What got in the way?
          </Link>
        </p>
      ) : null}

      {/*
       * Topic, goal and the parsing/reply-style settings used to live in the
       * header, which put three paragraphs and a link before the first message.
       * They are one click away rather than always on screen.
       */}
      <details className="group border-b border-border px-4 py-2 sm:px-6">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
          <ChevronRight
            aria-hidden="true"
            className="size-3 transition-transform group-open:rotate-90"
          />
          Thread details
        </summary>
        <div className="pt-1 pb-2">
          <ConversationDetailsEditor
            topic={detail.topic}
            goal={detail.goal}
            onSave={onSaveDetails}
          />
          {detail.parsingProfile ? (
            <ParsingProfileEditor
              key={detail.parsingProfile.senderEmail}
              profile={detail.parsingProfile}
              onSave={onSaveParsingProfile}
            />
          ) : null}
          {/* Behind the disclosure, below a rule: the one control here that
              overwrites a decision rather than describing one. */}
          <div className="mt-3 border-t border-border pt-3">
            <ReanalyseButton onReanalyse={onReanalyse} />
          </div>
        </div>
      </details>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 space-y-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
          {detail.messages.map((message) => {
            const day = new Date(message.sentAt).toDateString()
            const showDay = day !== lastDay
            lastDay = day

            const from = message.from.email.trim().toLowerCase()
            const mine = from === ownerEmail
            const speaker = mine
              ? 'You'
              : ownAddresses.has(from)
                ? // Another of the user's addresses is still the user, so name the
                  // address rather than the display name — both are "Nils Mertens".
                  message.from.email
                : (message.from.name ?? message.from.email)
            const files =
              attachmentsByMessage.get(message.providerMessageId) ?? []

            const unseen = isUnseen(message)
            const showUnseenBoundary = unseen && !shownUnseenBoundary
            if (unseen) shownUnseenBoundary = true

            return (
              <div key={message.providerMessageId}>
                {showUnseenBoundary ? (
                  <div className="my-6 flex items-center gap-3">
                    <span className="h-px flex-1 bg-border" />
                    {/* The one place the read mark is visible in here, and it is a
                      divider rather than a tag on purpose: it marks *where* new
                      mail starts, not that the thread is new. */}
                    <span
                      title={READ_META.description}
                      className="text-xs font-medium text-foreground"
                    >
                      {READ_META.label} messages
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                ) : null}
                {showDay ? (
                  <div className="my-6 flex items-center gap-3">
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-xs text-muted-foreground">
                      {dayLabel(message.sentAt)}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                ) : null}

                <div
                  className={cn(
                    'flex flex-col gap-1 py-1',
                    mine ? 'items-end' : 'items-start',
                  )}
                >
                  <div
                    className={cn(
                      'flex max-w-full items-baseline gap-2 text-xs text-muted-foreground',
                      mine && 'flex-row-reverse',
                    )}
                  >
                    <span className="min-w-0 truncate font-medium text-foreground">
                      {speaker}
                    </span>
                    <time dateTime={message.sentAt}>
                      {formatTime(message.sentAt)}
                    </time>
                  </div>

                  <MessageBody
                    html={message.bodyHtml}
                    text={message.body}
                    mine={mine}
                  />
                  <StrippedParts message={message} />

                  {files.length > 0 ? (
                    <ul className="flex max-w-full flex-wrap gap-2 sm:max-w-[80%]">
                      {files.map((file) => (
                        <li key={file.providerAttachmentId}>
                          {/* A link rather than a button: the bytes are served from
                            a real URL, so the browser opens or saves the file
                            itself and the app never handles the download. */}
                          <a
                            href={attachmentHref(detail.providerThreadId, file)}
                            target="_blank"
                            rel="noreferrer"
                            title={`Open ${file.filename}`}
                            className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                          >
                            <span className="max-w-56 truncate underline decoration-dotted underline-offset-2">
                              {file.filename}
                            </span>
                            {formatBytes(file.sizeBytes) ? (
                              <span className="text-muted-foreground/70">
                                {formatBytes(file.sizeBytes)}
                              </span>
                            ) : null}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            )
          })}

          <div ref={bottom} />
        </div>

        {mediaAttachments.length > 0 || detail.senderEmail ? (
          <>
            <aside
              aria-label="Thread overview"
              id="thread-media-overview-desktop"
              className="hidden w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-muted/20 lg:flex"
            >
              {detail.senderEmail ? (
                <ContactContextEditor
                  key={detail.senderEmail}
                  email={detail.senderEmail}
                  initialContext={detail.contactContext}
                  onSave={onSaveContactContext}
                  onSuggest={onSuggestContactContext}
                />
              ) : null}
              {mediaAttachments.length > 0 ? (
                <MediaOverview
                  attachments={mediaAttachments}
                  providerThreadId={detail.providerThreadId}
                  id="thread-media-overview-desktop-list"
                  hashFailures={mediaHashFailures}
                  checking={mediaCandidates.length > 0 && dedupedMedia === null}
                />
              ) : null}
            </aside>
            {mediaOpen ? (
              <div className="fixed inset-0 z-50 lg:hidden">
                <button
                  type="button"
                  aria-label="Close media and attachments"
                  onClick={() => setMediaOpen(false)}
                  className="absolute inset-0 bg-black/40"
                />
                <aside
                  aria-label="Thread overview"
                  id="thread-media-overview-mobile"
                  className="absolute inset-y-0 right-0 flex w-[min(22rem,90vw)] flex-col overflow-y-auto border-l border-border bg-background shadow-xl"
                >
                  {detail.senderEmail ? (
                    <ContactContextEditor
                      key={detail.senderEmail}
                      email={detail.senderEmail}
                      initialContext={detail.contactContext}
                      onSave={onSaveContactContext}
                      onSuggest={onSuggestContactContext}
                    />
                  ) : null}
                  {mediaAttachments.length > 0 ? (
                    <MediaOverview
                      attachments={mediaAttachments}
                      providerThreadId={detail.providerThreadId}
                      id="thread-media-overview-mobile-list"
                      onClose={() => setMediaOpen(false)}
                      hashFailures={mediaHashFailures}
                      checking={
                        mediaCandidates.length > 0 && dedupedMedia === null
                      }
                    />
                  ) : null}
                </aside>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {detail.replyable ? (
        <Composer
          accounts={detail.replyAccounts}
          provider={detail.provider}
          suggest={detail.suggestReply}
          onDraft={onDraft}
          onSend={onSend}
          onReviewReply={onReviewReply}
        />
      ) : (
        <div className="border-t border-border bg-muted/30 px-6 py-3 text-center text-xs text-muted-foreground">
          {/*
           * The user's own mark is named first, because it is the reason the
           * composer is gone that is not a guess — and the one that lives
           * somewhere they can change.
           */}
          {detail.senderUnreplyable
            ? 'This sender is on your can’t-reply list — remove the address in Settings to bring the reply box back on all their mail.'
            : detail.isAutomated
              ? 'This is an automated notification — there is nobody to reply to.'
              : 'This conversation has no address to reply to.'}
        </div>
      )}
    </div>
  )
}
