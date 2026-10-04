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

import type { ConversationDetail } from '#/lib/gmail/service.ts'
import type { ReplyAttachmentUpload } from '#/lib/gmail/send.ts'
import type { SenderProfileSettings } from '#/lib/conversation/index.ts'
import { isRichHtml } from '#/lib/mail/rich.ts'

import { StateBadge } from '#/components/state-badge'
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
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
  onSend,
}: {
  onSend: (
    body: string,
    attachments: ReplyAttachmentUpload[],
  ) => Promise<{ error: string | null }>
}) {
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<ReplyAttachmentUpload[]>([])
  const [readingFiles, setReadingFiles] = useState(false)
  const filePicker = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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

    try {
      const result = await onSend(trimmed, attachments)

      if (result.error) {
        setError(result.error)
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
        <p
          role="alert"
          className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

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
}: {
  detail: ConversationDetail
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
  ) => Promise<{ error: string | null }>
}) {
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [detail.messages.length])

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
        <StateBadge state={detail.state} />
      </header>

      <div className="flex-1 space-y-1 overflow-y-auto px-6 py-6">
        {detail.messages.map((message) => {
          const day = new Date(message.sentAt).toDateString()
          const showDay = day !== lastDay
          lastDay = day

          const mine = message.isFromOwner
          const files = attachmentsByMessage.get(message.gmailMessageId) ?? []

          return (
            <div key={message.gmailMessageId}>
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
                  <span className="font-medium text-foreground">
                    {mine ? 'You' : (message.from.name ?? message.from.email)}
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
                  <ul className="flex max-w-[80%] flex-wrap gap-2">
                    {files.map((file) => (
                      <li
                        key={file.gmailAttachmentId}
                        className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
                      >
                        {file.filename} · {formatBytes(file.sizeBytes)}
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

      {detail.isAutomated ? (
        <div className="border-t border-border bg-muted/30 px-6 py-3 text-center text-xs text-muted-foreground">
          This is an automated notification — there is nobody to reply to.
        </div>
      ) : (
        <Composer onSend={onSend} />
      )}
    </div>
  )
}
