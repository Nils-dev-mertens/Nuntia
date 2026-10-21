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
 */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { RecipientField } from '#/components/recipient-field.tsx'
import type { RecipientSuggestion } from '#/components/recipient-field.tsx'
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

export function Compose({
  accounts,
  suggestions,
  submit,
  loadStyle,
}: {
  accounts: ComposeAccount[]
  /** Addresses from the user's own mail, newest first. */
  suggestions: RecipientSuggestion[]
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [style, setStyle] = useState<ComposeStyle>({
    greeting: null,
    signature: null,
  })

  const filePicker = useRef<HTMLInputElement>(null)

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

  const inputClass =
    'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground'

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
        (total, file) => total + Math.floor((file.data.length * 3) / 4),
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
      setError(result.error)
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const addsSomething = Boolean(style.greeting || style.signature)

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col p-8">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold">New message</h1>
        <a
          href="/"
          className="text-xs font-medium text-primary hover:underline"
        >
          ← Back to inbox
        </a>
      </header>

      <form
        onSubmit={(event) => void onSubmit(event)}
        className="mt-6 space-y-2"
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-12 shrink-0">From</span>
          {accounts.length > 1 ? (
            <select
              value={accountId}
              disabled={busy}
              onChange={(event) => setAccountId(event.target.value)}
              className={cn(inputClass, 'max-w-xs')}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-foreground">{accounts[0]?.email ?? '—'}</span>
          )}
        </div>

        <RecipientField
          label="To"
          value={to}
          onChange={setTo}
          suggestions={suggestions}
          disabled={busy}
          required
          autoComplete="off"
          placeholder="Start typing a name or address"
          className={inputClass}
        />

        <div className="flex items-center gap-3 pl-14 text-xs text-muted-foreground">
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

        {showCc ? (
          <RecipientField
            label="Cc"
            value={cc}
            onChange={setCc}
            suggestions={suggestions}
            disabled={busy}
            autoComplete="off"
            className={inputClass}
          />
        ) : null}

        {showBcc ? (
          <RecipientField
            label="Bcc"
            value={bcc}
            onChange={setBcc}
            suggestions={suggestions}
            disabled={busy}
            autoComplete="off"
            className={inputClass}
          />
        ) : null}

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-12 shrink-0">Subject</span>
          <input
            required
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            disabled={busy}
            maxLength={300}
            autoComplete="off"
            className={inputClass}
          />
        </label>

        <textarea
          required
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            // Ctrl/Cmd+Enter sends; a plain Enter must stay a newline here.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          disabled={busy}
          rows={10}
          placeholder="Write your message…"
          className="mt-3 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/30"
        />

        {addsSomething ? (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">
              Added automatically when you send
            </p>
            {style.greeting ? (
              <p className="mt-1 whitespace-pre-wrap">{style.greeting}</p>
            ) : null}
            <p className="mt-1 italic">…your message…</p>
            {style.signature ? (
              <p className="mt-1 whitespace-pre-wrap">{style.signature}</p>
            ) : null}
            <p className="mt-2">
              Taken from this sender&rsquo;s saved reply style, your account
              default, or how you signed your last message. Change them in
              Settings.
            </p>
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Attachments to send">
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

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between pt-2">
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
              Ctrl+Enter to send
            </span>
          </div>
          <button
            type="submit"
            disabled={busy || readingFiles}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  )
}
