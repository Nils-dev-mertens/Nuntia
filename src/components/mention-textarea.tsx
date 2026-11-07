/**
 * A textarea that turns `@` into a team-member picker.
 *
 * The directory is small and local, so the picker is a plain filtered list rather
 * than a command palette: type `@`, keep typing to narrow by name, address or
 * role, then click or press Enter. Selecting inserts the address, which is the
 * part that was being typed out by hand — the name and role stay in the picker,
 * not in the mail.
 *
 * It is a wrapper rather than a hook because both composers need the same
 * keyboard rules, including the collision with the reply box's Enter-to-send:
 * while the picker is open, Enter chooses a person and must not send.
 */

import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'

import type { TeamMember } from '#/lib/team/types.ts'

/** The `@token` immediately before the caret, if there is one. */
function mentionAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return null

  return {
    start: caret - match[2].length - 1,
    query: match[2],
  }
}

function matches(member: TeamMember, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true

  return [member.name, member.email, member.role ?? ''].some((value) =>
    value.toLowerCase().includes(needle),
  )
}

export function MentionTextarea({
  value,
  onChange,
  members,
  textareaRef,
  onKeyDown,
  className,
  placeholder,
  rows,
  disabled,
  required,
  placement = 'below',
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  members: TeamMember[]
  /** The composer's own ref, so its existing growth effect keeps working. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  className?: string
  placeholder?: string
  rows?: number
  disabled?: boolean
  required?: boolean
  /** A reply box sits at the bottom of the screen; its list opens upward. */
  placement?: 'above' | 'below'
  ariaLabel?: string
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const [mention, setMention] = useState<{
    start: number
    query: string
  } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const suggestions = useMemo(
    () => (mention ? members.filter((m) => matches(m, mention.query)) : []),
    [members, mention],
  )

  function attachRef(element: HTMLTextAreaElement | null) {
    ownRef.current = element
    if (textareaRef) textareaRef.current = element
  }

  function syncMention() {
    const element = ownRef.current
    if (!element) return

    setMention(mentionAt(element.value, element.selectionStart))
    setActiveIndex(0)
  }

  function choose(member: TeamMember) {
    const element = ownRef.current
    if (!element || !mention) return

    const caret = element.selectionStart
    const inserted = `${member.email} `
    const next = `${value.slice(0, mention.start)}${inserted}${value.slice(caret)}`

    onChange(next)
    setMention(null)

    // The caret moves after React has rendered the new value; doing it now
    // would place it against the old string.
    requestAnimationFrame(() => {
      element.focus()
      const position = mention.start + inserted.length
      element.setSelectionRange(position, position)
    })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && suggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((index) => (index + 1) % suggestions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex(
          (index) => (index - 1 + suggestions.length) % suggestions.length,
        )
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        choose(suggestions[activeIndex])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(null)
        return
      }
    }

    onKeyDown?.(event)
  }

  return (
    <div className="relative">
      <textarea
        ref={attachRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
          setMention(
            mentionAt(event.target.value, event.target.selectionStart),
          )
          setActiveIndex(0)
        }}
        onKeyDown={handleKeyDown}
        onClick={syncMention}
        onKeyUp={(event) => {
          // Not while the picker is open: the arrow keys are already moving the
          // selection, and re-reading the token would reset it.
          if (event.key.startsWith('Arrow')) return
          if (!mention) syncMention()
        }}
        onBlur={() => setMention(null)}
        rows={rows}
        disabled={disabled}
        required={required}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={className}
      />

      {mention && suggestions.length > 0 ? (
        <ul
          role="listbox"
          aria-label="Team members"
          className={`absolute z-30 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-background py-1 shadow-lg ${
            placement === 'above' ? 'bottom-full mb-1' : 'mt-1'
          }`}
        >
          {suggestions.map((member, index) => (
            <li key={member.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(member)}
                className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs ${
                  index === activeIndex ? 'bg-muted' : 'hover:bg-muted/60'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">
                    {member.name}
                  </span>
                  <span className="block truncate text-muted-foreground">
                    {member.email}
                    {member.role ? ` · ${member.role}` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
