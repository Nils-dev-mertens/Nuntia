/**
 * A signature field with a formatting toolbar and a live preview.
 *
 * The stored format stays the tiny markup `signature.ts` understands — easy to
 * parse, impossible to inject through — but that is not something a
 * non-technical user should have to know. The toolbar inserts exactly that
 * markup around the selection, and the preview renders the value with
 * `signatureToHtml`: the same function the outgoing message calls, so the box
 * shows what will be sent rather than a second interpretation of the text.
 */

import { useRef } from 'react'

import { applySignatureFormat, signatureToHtml } from '#/lib/mail/signature.ts'
import type { SignatureFormat } from '#/lib/mail/signature.ts'

const buttonClass =
  'rounded border border-border bg-background px-2 py-0.5 text-xs text-foreground hover:bg-muted disabled:opacity-50'

export function SignatureField({
  value,
  onChange,
  maxLength = 1000,
  rows = 2,
  disabled,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  maxLength?: number
  rows?: number
  disabled?: boolean
  placeholder?: string
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  function format(kind: SignatureFormat) {
    const element = textareaRef.current
    if (!element || disabled) return

    const next = applySignatureFormat(
      value,
      element.selectionStart,
      element.selectionEnd,
      kind,
    )
    // The textarea's own `maxLength` does not apply to a programmatic change,
    // so the markers are refused rather than truncated mid-markup.
    if (next.value.length > maxLength) return

    onChange(next.value)

    // The caret is placed against the rendered value, not the old string.
    requestAnimationFrame(() => {
      element.focus()
      element.setSelectionRange(next.selectionStart, next.selectionEnd)
    })
  }

  return (
    <div>
      <div
        role="toolbar"
        aria-label="Signature formatting"
        className="mt-1 flex items-center gap-1"
      >
        <button
          type="button"
          disabled={disabled}
          aria-label="Bold"
          title="Bold"
          // Keeping the textarea focused preserves the selection the button acts on.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => format('bold')}
          className={buttonClass}
        >
          <span className="font-bold">B</span>
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label="Italic"
          title="Italic"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => format('italic')}
          className={buttonClass}
        >
          <span className="italic">I</span>
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label="Insert link"
          title="Insert link"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => format('link')}
          className={buttonClass}
        >
          Link
        </button>
      </div>

      <textarea
        ref={textareaRef}
        value={value}
        maxLength={maxLength}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="Signature"
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
      />

      <p className="mt-2 text-[10px] font-medium text-muted-foreground/80">
        Preview
      </p>
      {value.trim() ? (
        <div
          aria-label="Signature preview"
          className="mt-0.5 rounded-md border border-border bg-muted/20 px-2 py-1.5 text-sm text-foreground [&_a]:text-primary [&_a]:underline [&_p]:m-0"
          // `signatureToHtml` escapes the input before adding its own tags, and
          // only ever emits `p`, `strong`, `em`, `br` and allowlisted links.
          dangerouslySetInnerHTML={{ __html: signatureToHtml(value) }}
        />
      ) : (
        <p className="mt-0.5 rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground">
          Your signature will appear here as it will in the mail.
        </p>
      )}
    </div>
  )
}
