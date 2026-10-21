/**
 * A recipient field with address suggestions.
 *
 * The list is the addresses from the user's own mail — people they have written
 * to or heard from — filtered as they type, so a new message rarely needs an
 * address typed in full. The field stays a plain comma-separated input: multiple
 * recipients, paste from anywhere, and no chip state to get lost.
 *
 * Keyboard first, because this is a text field: ArrowDown/ArrowUp move the
 * highlight, Enter takes it, Escape dismisses. A highlighted option is taken on
 * `mousedown` rather than `click` so the input never loses focus first.
 */

import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { matchContactSuggestions } from '#/lib/contacts/matching.ts'
import { cn } from '#/lib/utils'

export type RecipientSuggestion = {
  email: string
  name: string | null
}

/** Split a header value into the addresses already committed to it. */
function addressesOf(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

export function RecipientField({
  label,
  value,
  onChange,
  suggestions,
  disabled,
  placeholder,
  required,
  className,
  autoComplete,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  suggestions: RecipientSuggestion[]
  disabled?: boolean
  placeholder?: string
  required?: boolean
  className?: string
  autoComplete?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  // The address being typed is the last comma-separated piece, so a suggestion
  // replaces it rather than being appended to it.
  const token = value.split(/[,;]/).at(-1)?.trim() ?? ''

  const matches = useMemo(() => {
    if (!open) return []
    return matchContactSuggestions(suggestions, token, addressesOf(value))
  }, [open, token, suggestions, value])

  function choose(suggestion: RecipientSuggestion) {
    const parts = addressesOf(value)
    if (parts.length === 0) parts.push(suggestion.email)
    else parts[parts.length - 1] = suggestion.email

    onChange(`${parts.join(', ')}, `)
    setOpen(false)
    input.current?.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open) {
        setOpen(true)
        return
      }
      if (matches.length === 0) return

      event.preventDefault()
      const next =
        event.key === 'ArrowDown'
          ? (active + 1) % matches.length
          : (active - 1 + matches.length) % matches.length
      setActive(next)
      return
    }

    if (event.key === 'Enter' && open && matches.length > 0) {
      // Otherwise this would submit the form with an address half-typed.
      event.preventDefault()
      // `.at()` rather than `[index]`: the index form is typed as always present,
      // which hides the empty case from the type checker and the linter both.
      const chosen = matches.at(Math.min(active, matches.length - 1))
      if (chosen) choose(chosen)
    }
  }

  return (
    <label className="flex items-start gap-2 text-xs text-muted-foreground">
      <span className="mt-2 w-12 shrink-0">{label}</span>
      <span className="relative min-w-0 flex-1">
        <input
          ref={input}
          required={required}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete={autoComplete}
          onChange={(event) => {
            onChange(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          // Closed on blur, but the options take the click on `mousedown`, which
          // happens before this fires — so choosing one works in one click.
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          aria-expanded={open && matches.length > 0}
          aria-autocomplete="list"
          className={className}
        />

        {open && matches.length > 0 ? (
          <ul
            role="listbox"
            className={cn(
              'absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border',
              'bg-card py-1 text-xs shadow-lg',
            )}
          >
            {matches.map((suggestion, index) => (
              <li key={suggestion.email}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    choose(suggestion)
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={cn(
                    'flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left',
                    index === active ? 'bg-muted' : 'bg-transparent',
                  )}
                >
                  <span className="min-w-0 truncate text-foreground">
                    {suggestion.name ?? suggestion.email}
                  </span>
                  <span className="min-w-0 shrink truncate text-muted-foreground">
                    {suggestion.email}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </span>
    </label>
  )
}
