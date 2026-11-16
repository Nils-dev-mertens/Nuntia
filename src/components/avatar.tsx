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

/**
 * The sender tiles from the inbox design, as (fill, initials) pairs.
 *
 * Each correspondent keeps one colour across the list, chosen from their
 * address so it survives a reload: the tile is a mark for a person, not a
 * decoration, and the same person changing colour between visits would make it
 * a worse one. Dark initials sit on the warm fills, light ones on the darker.
 */
const SENDER_TONES = [
  'bg-[#ff5722] text-[#0a0a0c]',
  'bg-[#00a744] text-[#0a0a0c]',
  'bg-[#ffa000] text-[#0a0a0c]',
  'bg-[#93000a] text-[#ffdad6]',
  'bg-[#5b4039] text-[#ffdad6]',
  'bg-[#b02f00] text-[#ffdad6]',
  'bg-[#353437] text-white',
] as const

function senderTone(email: string): string {
  let hash = 0
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) >>> 0
  }
  return SENDER_TONES[hash % SENDER_TONES.length] ?? SENDER_TONES[0]
}

export function Avatar({
  contact,
  className,
  tone = 'neutral',
}: {
  contact: AvatarContact | undefined
  className?: string
  /** `sender` is the coloured list-row tile; `neutral` is everything else. */
  tone?: 'neutral' | 'sender'
}) {
  const [failed, setFailed] = useState(false)

  if (!contact) return null

  const src = contact.avatarUrl && !failed ? contact.avatarUrl : null

  return (
    <span
      aria-hidden="true"
      title={contact.name ?? contact.email}
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-[4px]',
        'text-[9.5px] font-bold',
        tone === 'sender'
          ? cn(
              'outline outline-1 -outline-offset-1 outline-white/10',
              senderTone(contact.email),
            )
          : 'border border-border bg-muted text-muted-foreground',
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
