/** The contacts screens' own sidebar navigation, replacing the inbox sections. */

import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

import { cn } from '#/lib/utils'

export function ContactNav({
  active,
  email,
}: {
  active: 'index' | 'contact' | 'tags'
  /** The address shown under the navigation on a single contact. */
  email?: string | null
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <Link
        to="/"
        className="flex h-9 items-center gap-2 rounded-[4px] px-2.5 text-[12.5px] font-medium text-foreground/90 transition-colors hover:bg-muted/40"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to inbox
      </Link>
      <p className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
        Contacts
      </p>
      <Link
        to="/contacts"
        aria-current={active === 'index' ? 'page' : undefined}
        className={cn(
          'flex h-9 items-center rounded-[4px] px-2.5 text-[12.5px] font-medium transition-colors hover:bg-muted/40',
          active === 'index'
            ? 'bg-muted/70 font-semibold text-foreground'
            : 'text-foreground/90',
        )}
      >
        All contacts
      </Link>
      <Link
        to="/contacts/tags"
        aria-current={active === 'tags' ? 'page' : undefined}
        className={cn(
          'flex h-9 items-center rounded-[4px] px-2.5 text-[12.5px] font-medium transition-colors hover:bg-muted/40',
          active === 'tags'
            ? 'bg-muted/70 font-semibold text-foreground'
            : 'text-foreground/90',
        )}
      >
        Tags &amp; descriptions
      </Link>
      {email ? (
        <span
          className="truncate px-2.5 pt-1 text-[11.5px] text-muted-foreground"
          title={email}
        >
          {email}
        </span>
      ) : null}
    </div>
  )
}
