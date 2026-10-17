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

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import type {
  ActionFailure,
  ConversationDetail,
  ReplyDraftOutcome,
} from '#/lib/gmail/service.ts'
import type { ReplyAttachmentUpload } from '#/lib/gmail/send.ts'
import type { SenderProfileSettings } from '#/lib/conversation/index.ts'
import type { ConversationState } from '#/db/schema.ts'
import { isRichHtml } from '#/lib/mail/rich.ts'

import { StateBadge } from '#/components/state-badge'
import {
  DONE_META,
  READ_META,
  STATE_META,
  STATE_ORDER,
} from '#/lib/conversation-state'
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
  const base = 'max-w-[80%] rounded-lg border text-sm'
  const tone = mine
    ? 'border-primary/20 bg-primary/10 text-foreground'
    : 'border-border bg-card text-card-foreground'

  // Rich mail fills the bubble edge to edge: the sender's own padding would
  // otherwise sit inside ours and read as a stray white inset.
  if (isRichHtml(html)) {
    return (
      <div className={cn(base, tone, 'overflow-hidden p-0')}>
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

/** Marks a thread there is nobody to answer, next to the state badge. */
function NoReplyTag() {
  return (
    <span className="shrink-0 rounded-full border border-border bg-muted px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
      No reply
    </span>
  )
}

/** The user's own "handled" mark, shown beside the state it did not change. */
function DoneTag() {
  return (
    <span
      title={DONE_META.description}
      className="shrink-0 rounded-full border border-success/30 bg-success/15 px-1.5 py-px text-[10px] font-medium tracking-wide text-success uppercase"
    >
      {DONE_META.label}
    </span>
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
  onSet,
}: {
  /** The stored label, or null when the app's own answer stands. */
  current: ConversationState | null
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
              {STATE_META[state].label}
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
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        title={`Hide the reply box on every thread from ${senderEmail}. Undo this from the can’t-reply list in Settings.`}
        className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:border-foreground/25 disabled:opacity-50"
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

/** Re-run the decision layer for this thread, without waiting for a sync. */
function ReanalyseButton({
  onReanalyse,
}: {
  onReanalyse: () => Promise<{ error: string | null }>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await onReanalyse()
      if (result.error) setError(result.error)
    } catch {
      setError('Could not re-analyse this conversation.')
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
        className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:border-foreground/25 disabled:opacity-50"
      >
        {busy ? 'Re-analysing…' : 'Re-analyse'}
      </button>
      {error ? (
        <span role="alert" className="text-right text-xs text-destructive">
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
  gmailThreadId: string,
  file: ConversationDetail['attachments'][number],
): string {
  const thread = new URLSearchParams({ thread: gmailThreadId })
  return `/attachments/${encodeURIComponent(file.gmailAttachmentId)}?${thread}`
}

function ParsingProfileEditor({
  profile,
  onSave,
}: {
  profile: NonNullable<ConversationDetail['parsingProfile']>
  onSave: (
    profile: SenderProfileSettings,
    defaults: {
      greeting: string
      signature: string
      stripQuotedHistory: boolean
      stripGreeting: boolean
      stripSignature: boolean
    },
  ) => Promise<{ error: string | null }>
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
  const [defaultStripQuotedHistory, setDefaultStripQuotedHistory] = useState(
    profile.defaultStripQuotedHistory,
  )
  const [defaultStripGreeting, setDefaultStripGreeting] = useState(
    profile.defaultStripGreeting,
  )
  const [defaultStripSignature, setDefaultStripSignature] = useState(
    profile.defaultStripSignature,
  )
  const [replyStyleEnabled, setReplyStyleEnabled] = useState(
    profile.replyStyleEnabled,
  )
  const [replyGreeting, setReplyGreeting] = useState(profile.replyGreeting)
  const [replySignature, setReplySignature] = useState(profile.replySignature)
  const [defaultReplyGreeting, setDefaultReplyGreeting] = useState(
    profile.defaultReplyGreeting,
  )
  const [defaultReplySignature, setDefaultReplySignature] = useState(
    profile.defaultReplySignature,
  )

  useEffect(() => {
    setUseAccountParsingDefaults(profile.useAccountParsingDefaults)
    setStripQuotedHistory(profile.stripQuotedHistory)
    setStripGreeting(profile.stripGreeting)
    setStripSignature(profile.stripSignature)
    setDefaultStripQuotedHistory(profile.defaultStripQuotedHistory)
    setDefaultStripGreeting(profile.defaultStripGreeting)
    setDefaultStripSignature(profile.defaultStripSignature)
    setReplyStyleEnabled(profile.replyStyleEnabled)
    setReplyGreeting(profile.replyGreeting)
    setReplySignature(profile.replySignature)
    setDefaultReplyGreeting(profile.defaultReplyGreeting)
    setDefaultReplySignature(profile.defaultReplySignature)
  }, [profile])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await onSave(
        {
          useAccountParsingDefaults,
          stripQuotedHistory,
          stripGreeting,
          stripSignature,
          replyStyleEnabled,
          replyGreeting: replyStyleEnabled ? replyGreeting : null,
          replySignature: replyStyleEnabled ? replySignature : null,
        },
        {
          greeting: defaultReplyGreeting,
          signature: defaultReplySignature,
          stripQuotedHistory: defaultStripQuotedHistory,
          stripGreeting: defaultStripGreeting,
          stripSignature: defaultStripSignature,
        },
      )
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
        What Lumen removes from {profile.senderEmail}
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
        <p className="mb-2 text-xs font-medium text-foreground">
          Account-wide parsing defaults
        </p>
        {toggle(
          'quoted history',
          defaultStripQuotedHistory,
          setDefaultStripQuotedHistory,
        )}
        {toggle('greetings', defaultStripGreeting, setDefaultStripGreeting)}
        {toggle('signatures', defaultStripSignature, setDefaultStripSignature)}
      </div>
      <div className="border-t border-border pt-3">
        <p className="mb-2 text-xs font-medium text-foreground">
          Your account-wide reply defaults
        </p>
        <label className="block text-xs text-muted-foreground">
          Default greeting
          <input
            value={defaultReplyGreeting}
            maxLength={200}
            onChange={(event) => setDefaultReplyGreeting(event.target.value)}
            placeholder="Hi there,"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </label>
        <label className="mt-2 block text-xs text-muted-foreground">
          Default signature
          <textarea
            value={defaultReplySignature}
            maxLength={1000}
            rows={2}
            onChange={(event) => setDefaultReplySignature(event.target.value)}
            placeholder="Best,\nYour name"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </label>
      </div>
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
          {busy ? 'Saving…' : 'Save & re-parse'}
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
  suggest,
  onDraft,
  onSend,
}: {
  /** Addresses this reply could leave from, best first. */
  accounts: Array<{ id: string; email: string }>
  /** Whether a draft can be generated, and why not when it cannot. */
  suggest: ConversationDetail['suggestReply']
  /** Generate one draft. Never sends: the result lands in this box. */
  onDraft: (instructions: string | null) => Promise<ReplyDraftOutcome>
  onSend: (
    body: string,
    attachments: ReplyAttachmentUpload[],
    fromAccountId: string,
  ) => Promise<ActionFailure>
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
  const textarea = useRef<HTMLTextAreaElement>(null)

  // Grow to fit, up to a cap, so a long reply does not scroll in a tiny box.
  useEffect(() => {
    const el = textarea.current
    if (!el) return

    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [body])

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
    <div className="border-t border-border bg-card p-4">
      {error ? (
        <div
          role="alert"
          className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <p>{error}</p>
          {authRequired ? (
            <a
              href="/auth/google"
              className={cn(
                'mt-3 inline-flex h-8 items-center rounded-md bg-primary px-3',
                'text-xs font-medium text-primary-foreground',
              )}
            >
              Reconnect Google
            </a>
          ) : null}
        </div>
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

      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Only offered when there is a choice: a single-account install
              should not see a one-option dropdown on every reply. */}
          {accounts.length > 1 ? (
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              From
              <select
                value={fromAccountId}
                disabled={busy}
                onChange={(event) => setFromAccountId(event.target.value)}
                className="rounded-md border border-border bg-background px-1.5 py-0.5 text-xs text-foreground"
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
          <span className="text-xs text-muted-foreground">
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
  onSaveParsingProfile,
  onSend,
  onDraft,
  onReanalyse,
  onSetStateOverride,
  onSetDone,
  onMarkSenderUnreplyable,
}: {
  detail: ConversationDetail
  onReanalyse: () => Promise<{ error: string | null }>
  /**
   * Generate a draft reply for this thread. The draft is returned, not stored,
   * and puts text in the composer — sending stays a separate, deliberate act.
   */
  onDraft: (instructions: string | null) => Promise<ReplyDraftOutcome>
  onSetStateOverride: (
    state: ConversationState | null,
  ) => Promise<{ error: string | null }>
  onSetDone: (done: boolean) => Promise<{ error: string | null }>
  /**
   * Add the thread's other party to the can't-reply list. Takes no arguments on
   * purpose: the server resolves the mailbox and the address from the thread, so
   * the caller cannot name a sender the thread is not.
   */
  onMarkSenderUnreplyable: () => Promise<{ error: string | null }>
  onSaveParsingProfile: (
    profile: SenderProfileSettings,
    defaults: {
      greeting: string
      signature: string
      stripQuotedHistory: boolean
      stripGreeting: boolean
      stripSignature: boolean
    },
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
}) {
  const bottom = useRef<HTMLDivElement>(null)

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

  const attachmentsByMessage = new Map<
    string,
    ConversationDetail['attachments']
  >()
  for (const attachment of detail.attachments) {
    const list = attachmentsByMessage.get(attachment.gmailMessageId) ?? []
    list.push(attachment)
    attachmentsByMessage.set(attachment.gmailMessageId, list)
  }

  let lastDay = ''
  // `New messages` is drawn from the mark the loader sent, not from a fresh read:
  // the server records the same instant this page renders, and re-loading to see
  // it would erase the divider the moment it appeared.
  const seenAtMs = detail.seenAt ? Date.parse(detail.seenAt) : 0
  const isUnseen = (message: ConversationDetail['messages'][number]): boolean =>
    !message.isFromOwner && Date.parse(message.sentAt) > seenAtMs
  let shownUnseenBoundary = false

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-foreground">
            {detail.topic ?? detail.subject}
          </h1>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {detail.participants.map((p) => p.name ?? p.email).join(', ')}
          </p>
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
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            {!detail.replyable ? <NoReplyTag /> : null}
            {detail.done ? <DoneTag /> : null}
            <StateBadge state={detail.state} />
          </div>
          <div className="flex items-start gap-2">
            {/*
             * Always offered, and it reads as a statement of where the thread is
             * as well as a control: the picker shows the stored label, or
             * Automatic when the app's own answer stands — including when a
             * sender-level call of the user's is what put it there.
             */}
            <StateLabelPicker
              current={detail.stateOverride}
              onSet={onSetStateOverride}
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
            <ReanalyseButton onReanalyse={onReanalyse} />
          </div>
        </div>
      </header>

      {/*
       * Says what the tag above means, in the one place with room for it: the two
       * marks are easy to confuse, and "you handled this, so it is out of the open
       * groups" is the difference in a sentence.
       */}
      {detail.done ? (
        <p className="border-y border-border bg-success/5 px-6 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-success">{DONE_META.label}</span> —{' '}
          {DONE_META.detail}
        </p>
      ) : null}

      <div className="flex-1 space-y-1 overflow-y-auto px-6 py-6">
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
          const files = attachmentsByMessage.get(message.gmailMessageId) ?? []

          const unseen = isUnseen(message)
          const showUnseenBoundary = unseen && !shownUnseenBoundary
          if (unseen) shownUnseenBoundary = true

          return (
            <div key={message.gmailMessageId}>
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
                    'flex items-baseline gap-2 text-xs text-muted-foreground',
                    mine && 'flex-row-reverse',
                  )}
                >
                  <span className="font-medium text-foreground">{speaker}</span>
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
                  <ul className="flex max-w-[80%] flex-wrap gap-2">
                    {files.map((file) => (
                      <li key={file.gmailAttachmentId}>
                        {/* A link rather than a button: the bytes are served from
                            a real URL, so the browser opens or saves the file
                            itself and the app never handles the download. */}
                        <a
                          href={attachmentHref(detail.gmailThreadId, file)}
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

      {detail.replyable ? (
        <Composer
          accounts={detail.replyAccounts}
          suggest={detail.suggestReply}
          onDraft={onDraft}
          onSend={onSend}
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
