/**
 * A contact's avatar.
 *
 * Initials are the real fallback, not a placeholder: Gravatar answers 404 when
 * an address has no account (the URL asks for `d=404`), and the image is dropped
 * on load failure so the letters underneath show instead of a broken icon.
 */

import { useState } from 'react'

import { cn } from '#/lib/utils'

export type AvatarContact = {
  name: string | null
  email: string
  initials: string
  avatarUrl: string | null
}

export function Avatar({
  contact,
  className,
}: {
  contact: AvatarContact | undefined
  className?: string
}) {
  const [failed, setFailed] = useState(false)

  if (!contact) return null

  const src = contact.avatarUrl && !failed ? contact.avatarUrl : null

  return (
    <span
      aria-hidden="true"
      title={contact.name ?? contact.email}
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full',
        'border border-border bg-muted text-[10px] font-semibold text-muted-foreground',
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        contact.initials
      )}
    </span>
  )
}
