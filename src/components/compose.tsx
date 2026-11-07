/**
 * Compose a new message.
 *
 * The counterpart of the reply box: no thread to quote, but the same
 * restoration. The user types only what they want to say — the greeting and
 * signature are added on send, from the same profile a reply would use, and the
 * panel under the body says exactly what they will be so nothing arrives
 * unannounced. The two things this shares with replies are the attachment limits
 * and the From picker, because those are properties of the mailbox rather than of
 * a thread.
 *
 * A half-written message is the most expensive thing in this app to lose, so the
 * text is kept as a draft on this device as it is typed and put back when the
 * window is opened again. Attachments are not part of that: they are megabytes of
 * base64, and a draft store that fights the quota is worse than none.
 */

import { useEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'

import { MentionTextarea } from '#/components/mention-textarea.tsx'
import { RecipientField } from '#/components/recipient-field.tsx'
import type { RecipientSuggestion } from '#/components/recipient-field.tsx'
import type { RecipientHistory } from '#/lib/contacts/index.ts'
import { fixTypingSlips } from '#/lib/mail/typos.ts'
import type { TeamMember } from '#/lib/team/types.ts'
import { cn, encodeFileBytes } from '#/lib/utils'

export type ComposeAccount = { id: string; email: string }

export type ComposeStyle = {
  greeting: string | null
  signature: string | null
}

type Attachment = {
  filename: string
  contentType: string
  /** Standard base64. */
  data: string
}

export type ComposeInput = {
  accountId: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  attachments: Attachment[]
}

/** Split a header field on commas/semicolons the way every mail client does. */
function addressesOf(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** How long to wait after typing before asking what will be added. */
const STYLE_PREVIEW_DEBOUNCE_MS = 400

/** How long to wait after typing before writing the draft out. */
const DRAFT_SAVE_DEBOUNCE_MS = 300

/** Bumped when the stored shape changes, so an old draft is ignored, not misread. */
const DRAFT_VERSION = 1

type SavedDraft = {
  version: number
  accountId: string
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
}

/**
 * The draft this person left in this browser, or null.
 *
 * Storage is read defensively: it throws in some private modes, an older build
 * may have left a different shape behind, and a compose window that cannot
 * remember a draft must still open.
 */
function readDraft(key: string): SavedDraft | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null

    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null

    const draft = parsed as Partial<SavedDraft>
    if (draft.version !== DRAFT_VERSION) return null

    const text = (value: unknown) => (typeof value === 'string' ? value : '')
    return {
      version: DRAFT_VERSION,
      accountId: text(draft.accountId),
      to: text(draft.to),
      cc: text(draft.cc),
      bcc: text(draft.bcc),
      subject: text(draft.subject),
      body: text(draft.body),
    }
  } catch {
    return null
  }
}

function writeDraft(key: string, draft: SavedDraft): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(draft))
  } catch {
    // A full or blocked store is not a reason to interrupt a send.
  }
}

function removeDraft(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {}
}

/** Base64 is 4 characters per 3 bytes; exact enough for a size label. */
function attachmentBytes(attachment: Attachment): number {
  return Math.floor((attachment.data.length * 3) / 4)
}

/** The monogram the context card shows when there is no avatar. */
function initialOf(value: string): string {
  const first = value.trim().charAt(0)
  return (first || '?').toUpperCase()
}

/** A short date in the reader's own locale, for the context card. */
function formatDay(value: Date): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
  }).format(date)
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function Compose({
  accounts,
  suggestions,
  teamMembers,
  submit,
  loadStyle,
  loadContext,
}: {
  accounts: ComposeAccount[]
  /** Addresses from the user's own mail, newest first. */
  suggestions: RecipientSuggestion[]
  /** Colleagues the @mention picker can insert. */
  teamMembers: TeamMember[]
  /** Runs on the server and reports a message to show, or the thread created. */
  submit: (input: ComposeInput) => Promise<{
    error: string | null
    threadId: string | null
  }>
  /** The greeting and signature the server would add for this recipient. */
  loadStyle: (input: {
    accountId: string
    recipient: string | null
  }) => Promise<ComposeStyle>
  /** The stored threads with this recipient, or null when there are none. */
  loadContext: (input: {
    accountId: string
    email: string
  }) => Promise<RecipientHistory | null>
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [readingFiles, setReadingFiles] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [style, setStyle] = useState<ComposeStyle>({
    greeting: null,
    signature: null,
  })
  const [history, setHistory] = useState<RecipientHistory | null>(null)
  const [fixNote, setFixNote] = useState<string | null>(null)
  const [undoFix, setUndoFix] = useState<{
    subject: string
    body: string
  } | null>(null)

  const filePicker = useRef<HTMLInputElement>(null)

  // One draft per person rather than per message: the accounts belong to a
  // single user, so their set is a stable key that a different person signing in
  // on this browser cannot read.
  const draftKey = `nuntia:compose-draft:${accounts
    .map((account) => account.id)
    .sort()
    .join(',')}`

  const hasContent = Boolean(
    to.trim() || cc.trim() || bcc.trim() || subject.trim() || body.trim(),
  )

  // Restore before the save effect is allowed to look at the form. Writing an
  // empty draft over the saved one on mount is exactly how a refresh would eat a
  // half-written message.
  const [hydrated, setHydrated] = useState(false)
  const restoreAttempted = useRef(false)

  useEffect(() => {
    if (restoreAttempted.current) return
    restoreAttempted.current = true

    const draft = readDraft(draftKey)
    if (draft) {
      if (draft.accountId && accounts.some((a) => a.id === draft.accountId)) {
        setAccountId(draft.accountId)
      }
      setTo(draft.to)
      setCc(draft.cc)
      setBcc(draft.bcc)
      setShowCc(Boolean(draft.cc))
      setShowBcc(Boolean(draft.bcc))
      setSubject(draft.subject)
      setBody(draft.body)
    }
    setHydrated(true)
  }, [draftKey, accounts])

  useEffect(() => {
    if (!hydrated) return

    const timer = setTimeout(() => {
      if (!hasContent) {
        removeDraft(draftKey)
        return
      }
      writeDraft(draftKey, {
        version: DRAFT_VERSION,
        accountId,
        to,
        cc,
        bcc,
        subject,
        body,
      })
    }, DRAFT_SAVE_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [hydrated, hasContent, draftKey, accountId, to, cc, bcc, subject, body])

  // Held in a ref so the preview effect keys off the recipient alone: the prop is
  // a fresh closure on every parent render, and re-running the request on each of
  // those would be a pointless round trip per keystroke elsewhere on the page.
  const loadStyleRef = useRef(loadStyle)
  loadStyleRef.current = loadStyle

  const recipient = addressesOf(to)[0] ?? null

  useEffect(() => {
    if (!accountId) return

    let cancelled = false
    const timer = setTimeout(() => {
      void loadStyleRef
        .current({ accountId, recipient })
        .then((result) => {
          if (!cancelled) setStyle(result)
        })
        .catch(() => {})
    }, STYLE_PREVIEW_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [accountId, recipient])

  const loadContextRef = useRef(loadContext)
  loadContextRef.current = loadContext

  // Who this person is, from the user's own mail: the name it knows them by and
  // what the last thread was about. Debounced like the style preview because the
  // address changes a character at a time.
  useEffect(() => {
    if (!accountId || !recipient) {
      setHistory(null)
      return
    }

    let cancelled = false
    const timer = setTimeout(() => {
      void loadContextRef
        .current({ accountId, email: recipient })
        .then((result) => {
          if (!cancelled) setHistory(result)
        })
        .catch(() => {})
    }, STYLE_PREVIEW_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [accountId, recipient])

  /** Inputs inside the composer's rows: the row draws the frame, not the field. */
  const fieldInputClass =
    'w-full border-0 bg-transparent p-0 text-sm text-foreground outline-none placeholder:text-muted-foreground/60'

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return

    setError(null)
    setReadingFiles(true)
    try {
      const selected = Array.from(files)
      if (attachments.length + selected.length > 10) {
        setError('Attach no more than 10 files per message.')
        return
      }

      const currentBytes = attachments.reduce(
        (total, file) => total + attachmentBytes(file),
        0,
      )
      const added: Attachment[] = []
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

  /**
   * Fix the slips that are wrong in any language, and nothing that needs to know
   * what the sentence means. The previous text is kept so this stays undoable.
   */
  function fixTypos() {
    const subjectFix = fixTypingSlips(subject)
    const bodyFix = fixTypingSlips(body)
    const count = subjectFix.fixes.length + bodyFix.fixes.length

    if (count === 0) {
      setUndoFix(null)
      setFixNote('No typing slips found.')
      return
    }

    setUndoFix({ subject, body })
    setSubject(subjectFix.text)
    setBody(bodyFix.text)
    setFixNote(
      `Fixed ${count} ${count === 1 ? 'typing slip' : 'typing slips'}.`,
    )
  }

  function undoFixTypos() {
    if (!undoFix) return
    setSubject(undoFix.subject)
    setBody(undoFix.body)
    setUndoFix(null)
    setFixNote(null)
  }

  function discardDraft() {
    if (
      !window.confirm(
        'Discard this draft? What you have written cannot be recovered.',
      )
    ) {
      return
    }

    setTo('')
    setCc('')
    setBcc('')
    setSubject('')
    setBody('')
    setAttachments([])
    setError(null)
    removeDraft(draftKey)
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    const toAddresses = addressesOf(to)
    const ccAddresses = addressesOf(cc)
    const bccAddresses = addressesOf(bcc)

    if (
      toAddresses.length === 0 &&
      ccAddresses.length === 0 &&
      bccAddresses.length === 0
    ) {
      setError('Add at least one recipient.')
      return
    }
    if (!subject.trim()) {
      setError('Give the message a subject.')
      return
    }
    if (!body.trim() && attachments.length === 0) {
      setError('Write something, or attach a file.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const result = await submit({
        accountId,
        to: toAddresses,
        cc: ccAddresses,
        bcc: bccAddresses,
        subject: subject.trim(),
        body,
        attachments,
      })

      // Only a message that left is cleared: a refused send keeps its draft, so
      // the retry still has the text.
      if (!result.error) removeDraft(draftKey)
      setError(result.error)
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  /** A drag is only ours when it carries files, not when it moves text around. */
  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setDropping(true)
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    // Crossing into a child fires this too; only a real exit clears the overlay.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDropping(false)
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setDropping(false)
    if (!busy) void addFiles(event.dataTransfer.files)
  }

  const addsSomething = Boolean(style.greeting || style.signature)
  const showsSidebar = Boolean(history) || addsSomething || Boolean(recipient)
  const attachedBytes = attachments.reduce(
    (total, file) => total + attachmentBytes(file),
    0,
  )

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative min-h-screen"
    >
      {dropping ? (
        <>
          <div className="pointer-events-none fixed inset-0 z-20 bg-background/70 backdrop-blur-sm" />
          <div className="pointer-events-none fixed inset-4 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary/50 bg-card/80 text-center">
            <p className="text-sm font-semibold text-foreground">
              Drop files to attach
            </p>
            <p className="text-xs text-muted-foreground">
              Up to 18 MB in total, 25 MB per file.
            </p>
          </div>
        </>
      ) : null}

      <div className="mx-auto w-full max-w-5xl px-4 pt-6 pb-10 sm:px-6 lg:pt-10">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <a
              href="/"
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <span aria-hidden>←</span> Inbox
            </a>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
              New message
            </h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Write what you want to say. The greeting and signature are added
              when you send.
            </p>
          </div>
          {hydrated && hasContent && !busy ? (
            <span className="rounded-full border border-border bg-card/70 px-3 py-1 text-xs text-muted-foreground">
              Draft kept on this device
            </span>
          ) : null}
        </header>

        <div
          className={cn(
            'mt-6 grid items-start gap-4',
            showsSidebar && 'lg:grid-cols-[minmax(0,1fr)_20rem]',
          )}
        >
          <form
            onSubmit={(event) => void onSubmit(event)}
            className="rounded-xl border border-border bg-card shadow-sm"
          >
            <div className="divide-y divide-border">
              <div className="flex items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground focus-within:bg-muted/20">
                <span className="w-12 shrink-0">From</span>
                {accounts.length > 1 ? (
                  <select
                    value={accountId}
                    disabled={busy}
                    onChange={(event) => setAccountId(event.target.value)}
                    className="max-w-xs rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                  >
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.email}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="truncate text-sm text-foreground">
                    {accounts[0]?.email ?? '—'}
                  </span>
                )}
              </div>

              <div className="px-4 py-2.5 focus-within:bg-muted/20">
                <RecipientField
                  label="To"
                  value={to}
                  onChange={setTo}
                  suggestions={suggestions}
                  disabled={busy}
                  required
                  autoComplete="off"
                  placeholder="Start typing a name or address"
                  className={fieldInputClass}
                />
              </div>

              {showCc ? (
                <div className="px-4 py-2.5 focus-within:bg-muted/20">
                  <RecipientField
                    label="Cc"
                    value={cc}
                    onChange={setCc}
                    suggestions={suggestions}
                    disabled={busy}
                    autoComplete="off"
                    className={fieldInputClass}
                  />
                </div>
              ) : null}

              {showBcc ? (
                <div className="px-4 py-2.5 focus-within:bg-muted/20">
                  <RecipientField
                    label="Bcc"
                    value={bcc}
                    onChange={setBcc}
                    suggestions={suggestions}
                    disabled={busy}
                    autoComplete="off"
                    className={fieldInputClass}
                  />
                </div>
              ) : null}

              {showCc && showBcc ? null : (
                <div className="flex items-center gap-4 py-1.5 pr-4 pl-16 text-xs text-muted-foreground">
                  {showCc ? null : (
                    <button
                      type="button"
                      onClick={() => setShowCc(true)}
                      className="hover:text-foreground"
                    >
                      Add Cc
                    </button>
                  )}
                  {showBcc ? null : (
                    <button
                      type="button"
                      onClick={() => setShowBcc(true)}
                      className="hover:text-foreground"
                    >
                      Add Bcc
                    </button>
                  )}
                </div>
              )}

              <label className="flex items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground focus-within:bg-muted/20">
                <span className="w-12 shrink-0">Subject</span>
                <input
                  required
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  disabled={busy}
                  maxLength={300}
                  autoComplete="off"
                  placeholder="What is this about?"
                  className={fieldInputClass}
                />
              </label>
            </div>

            <div className="border-t border-border px-4 py-3">
              <MentionTextarea
                required
                members={teamMembers}
                value={body}
                onChange={setBody}
                onKeyDown={(event) => {
                  // Ctrl/Cmd+Enter sends; a plain Enter must stay a newline here.
                  if (
                    event.key === 'Enter' &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
                disabled={busy}
                rows={12}
                placeholder="Write your message…  (@ a teammate to insert their address)"
                className="min-h-56 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/30"
              />
            </div>

            {attachments.length > 0 ? (
              <div className="space-y-2 border-t border-border px-4 py-3">
                <ul
                  className="flex flex-wrap gap-2"
                  aria-label="Attachments to send"
                >
                  {attachments.map((attachment, index) => (
                    <li
                      key={`${attachment.filename}-${index}`}
                      className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
                    >
                      <span className="max-w-56 truncate">
                        {attachment.filename}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {fileSize(attachmentBytes(attachment))}
                      </span>
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
                <p className="text-xs text-muted-foreground">
                  {attachments.length === 1
                    ? '1 file'
                    : `${attachments.length} files`}
                  {' · '}
                  {fileSize(attachedBytes)} of 18 MB
                </p>
              </div>
            ) : null}

            <input
              ref={filePicker}
              type="file"
              multiple
              className="hidden"
              aria-label="Choose attachments"
              onChange={(event) => void addFiles(event.target.files)}
            />

            {error ? (
              <p
                role="alert"
                className="mx-4 mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            ) : null}

            <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t border-border bg-card/95 px-4 py-3 backdrop-blur">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => filePicker.current?.click()}
                  disabled={busy || readingFiles || attachments.length >= 10}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  {readingFiles ? 'Adding…' : 'Attach files'}
                </button>
                <button
                  type="button"
                  onClick={fixTypos}
                  disabled={busy || (!body.trim() && !subject.trim())}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  Fix typos
                </button>
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  Ctrl/⌘ + Enter to send
                </span>
                {fixNote ? (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {fixNote}
                    {undoFix ? (
                      <button
                        type="button"
                        onClick={undoFixTypos}
                        className="text-primary hover:underline"
                      >
                        Undo
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {hasContent ? (
                  <button
                    type="button"
                    onClick={discardDraft}
                    disabled={busy}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    Discard
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={busy || readingFiles}
                  className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          </form>

          {showsSidebar ? (
            <aside className="space-y-3 lg:sticky lg:top-6">
              {history ? (
                <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-foreground"
                    >
                      {initialOf(history.name || recipient || '?')}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {history.name ?? recipient}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {history.threadCount === 1
                          ? '1 earlier thread'
                          : `${history.threadCount} earlier threads`}
                      </p>
                    </div>
                  </div>

                  {history.recent[0] ? (
                    <div className="mt-3 space-y-1 border-t border-border pt-3 text-xs">
                      <p className="truncate font-medium text-foreground">
                        {history.recent[0].subject}
                      </p>
                      <p className="text-muted-foreground">
                        {history.recent[0].awaitingReply
                          ? 'You wrote last'
                          : 'They wrote last'}
                        {' · '}
                        {formatDay(history.recent[0].lastMessageAt)}
                      </p>
                      {history.recent[0].topic ? (
                        <p className="italic text-muted-foreground">
                          {history.recent[0].topic}
                        </p>
                      ) : null}
                      <a
                        href={`/conversations/${encodeURIComponent(history.recent[0].providerThreadId)}`}
                        className="inline-block text-primary hover:underline"
                      >
                        Open thread →
                      </a>
                    </div>
                  ) : null}

                  {history.recent.length > 1 ? (
                    <ul className="mt-3 space-y-1 border-t border-border pt-3 text-xs">
                      {history.recent.slice(1).map((thread) => (
                        <li key={thread.providerThreadId} className="truncate">
                          <a
                            href={`/conversations/${encodeURIComponent(thread.providerThreadId)}`}
                            className="text-muted-foreground hover:text-foreground hover:underline"
                          >
                            {thread.subject}
                          </a>
                          <span className="text-muted-foreground">
                            {' · '}
                            {formatDay(thread.lastMessageAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ) : null}

              {addsSomething ? (
                <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
                  <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Sent with your message
                  </h2>
                  <div className="mt-2 space-y-2 text-xs">
                    {style.greeting ? (
                      <p className="whitespace-pre-wrap text-foreground">
                        {style.greeting}
                      </p>
                    ) : null}
                    <p className="italic text-muted-foreground">
                      …your message…
                    </p>
                    {style.signature ? (
                      <p className="whitespace-pre-wrap text-foreground">
                        {style.signature}
                      </p>
                    ) : null}
                  </div>
                  <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
                    From this sender&rsquo;s saved style, your account default,
                    or how you signed last time. Change in{' '}
                    <a
                      href="/settings"
                      className="text-primary hover:underline"
                    >
                      Settings
                    </a>
                    .
                  </p>
                </section>
              ) : null}

              {!history && !addsSomething ? (
                <section className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">
                  {recipient
                    ? 'No earlier mail with this person. This would be the first thread.'
                    : 'Add a recipient to see what your mail already knows about them.'}
                </section>
              ) : null}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  )
}
