/**
 * Every contact the app knows, with the short relationship description.
 *
 * The address book is the mail itself, so this is built from the learned
 * contacts and unioned with any profile that has no contact row — a note must
 * never become invisible because its address was not seen in a recent sync.
 * Alphabetical rather than by recency: a directory is for finding a person, and
 * recency is already what the inbox is for.
 */

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { ChevronRight, Search, X } from 'lucide-react'

import { AppShell } from '#/components/app-shell.tsx'
import { ContactNav } from '#/components/contact-nav.tsx'
import { fetchContactDirectory } from '#/lib/contacts/directory.ts'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/contacts/')({
  loader: async () => {
    const payload = await fetchContactDirectory()
    if (!payload.signedIn) throw redirect({ to: '/sign-in' })
    return payload
  },
  component: ContactsPage,
})

/** One or two letters for the avatar; the page does not need the full helper. */
function initialsOf(name: string | null, email: string): string {
  const words = (name ?? '')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
  if (words.length > 0) {
    const first = words[0]?.at(0) ?? ''
    const last = words.length > 1 ? (words.at(-1)?.at(0) ?? '') : ''
    return (first + last).toUpperCase()
  }
  return (email.split('@')[0] ?? email).slice(0, 2).toUpperCase()
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso))
}

function ContactsPage() {
  const data = Route.useLoaderData()
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  /** The organisation domain being filtered on, or null for all of them. */
  const [activeOrg, setActiveOrg] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(query)
  const searchRef = useRef<HTMLInputElement>(null)

  // `/` jumps to the search box, the way a list this long is normally scanned.
  // Skipped while the user is already typing somewhere, so the character still
  // works as itself in a field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return
      }
      event.preventDefault()
      searchRef.current?.focus()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const needle = deferredQuery.trim().toLowerCase()
  const filtering =
    needle.length > 0 || activeTag !== null || activeOrg !== null

  // Filtered in the browser on purpose: the directory is already one read of at
  // most a thousand people, and a search that waited for a round trip would be
  // slower than the typing that prompted it.
  const contacts = useMemo(
    () =>
      data.contacts.filter((contact) => {
        if (activeOrg && contact.organization?.domain !== activeOrg) {
          return false
        }
        if (
          activeTag &&
          !contact.tags.some(
            (tag) => tag.toLowerCase() === activeTag.toLowerCase(),
          )
        ) {
          return false
        }
        if (needle.length === 0) return true
        return [
          contact.name,
          contact.email,
          contact.description,
          contact.organization?.name,
          contact.organization?.domain,
          ...contact.tags,
        ].some((value) => value?.toLowerCase().includes(needle))
      }),
    [data.contacts, needle, activeTag, activeOrg],
  )

  const allTags = useMemo(
    () =>
      [...new Set(data.contacts.flatMap((contact) => contact.tags))].sort(
        (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }),
      ),
    [data.contacts],
  )

  /** One entry per organisation domain, named after the domain's own label. */
  const allOrganizations = useMemo(() => {
    const byDomain = new Map<string, string>()
    for (const contact of data.contacts) {
      if (contact.organization) {
        byDomain.set(contact.organization.domain, contact.organization.name)
      }
    }
    return [...byDomain].sort((a, b) =>
      a[1].localeCompare(b[1], undefined, { sensitivity: 'base' }),
    )
  }, [data.contacts])

  function clearFilters() {
    setQuery('')
    setActiveTag(null)
    setActiveOrg(null)
  }

  return (
    <AppShell accounts={data.accounts} nav={<ContactNav active="index" />}>
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <header>
          <h1 className="text-2xl font-bold">Contacts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {filtering ? (
              <>
                {contacts.length} of {data.contacts.length}{' '}
                {data.contacts.length === 1 ? 'person' : 'people'} match.{' '}
                <button
                  type="button"
                  onClick={clearFilters}
                  className="font-medium text-primary hover:underline"
                >
                  Clear
                </button>
              </>
            ) : (
              <>
                {data.contacts.length}{' '}
                {data.contacts.length === 1 ? 'person' : 'people'} you have
                corresponded with, and what the app understands about each
                relationship.
              </>
            )}
          </p>
        </header>

        <div className="mt-5 flex items-center gap-2 rounded-lg border border-border bg-card px-3 focus-within:ring-2 focus-within:ring-ring">
          <Search
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
            }}
            placeholder="Search by name, address, description or tag"
            aria-label="Search contacts"
            className="h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          {query.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
              aria-label="Clear search"
              className="shrink-0 rounded-[4px] p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          ) : (
            <kbd className="hidden shrink-0 rounded border border-border px-1.5 text-[10px] text-muted-foreground sm:block">
              /
            </kbd>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
            Tags
          </span>
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-pressed={activeTag === tag}
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                activeTag === tag
                  ? 'border-primary/40 bg-primary/15 font-medium text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground',
              )}
            >
              {tag}
            </button>
          ))}
          {allTags.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">
              No tags yet — add one on a person.
            </span>
          ) : null}
          {/** The vocabulary itself lives on its own screen, like a settings panel. */}
          <Link
            to="/contacts/tags"
            className="ml-auto shrink-0 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Manage tags
          </Link>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
            Organisations
          </span>
          {allOrganizations.map(([domain, name]) => (
            <button
              key={domain}
              type="button"
              aria-pressed={activeOrg === domain}
              title={domain}
              onClick={() => setActiveOrg(activeOrg === domain ? null : domain)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                activeOrg === domain
                  ? 'border-primary/40 bg-primary/15 font-medium text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground',
              )}
            >
              {name}
            </button>
          ))}
          {allOrganizations.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">
              No company addresses yet — personal mail stays ungrouped.
            </span>
          ) : null}
          {/** The grouped view has its own tab; this row stays for quick filters. */}
          <Link
            to="/contacts/organisations"
            className="ml-auto shrink-0 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            View all
          </Link>
        </div>

        {data.contacts.length === 0 ? (
          <p className="mt-6 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            No contacts yet. People appear here as your mail syncs.
          </p>
        ) : contacts.length === 0 ? (
          <p className="mt-6 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            No contact matches that. Try a shorter name, an address, or one of
            the tags above.
          </p>
        ) : (
          <ul className="mt-6 divide-y divide-border rounded-lg border border-border bg-card">
            {contacts.map((contact) => (
              <li key={contact.email}>
                <Link
                  to="/contacts/$email"
                  params={{ email: contact.email }}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary"
                  >
                    {initialsOf(contact.name, contact.email)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {contact.name ?? contact.email}
                    </span>
                    {contact.name ? (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {contact.email}
                      </span>
                    ) : null}
                    <span
                      className={cn(
                        'mt-0.5 block text-xs text-muted-foreground',
                        contact.description ? 'line-clamp-2' : 'italic',
                      )}
                    >
                      {contact.description ?? 'No relationship description yet'}
                    </span>
                    {contact.tags.length > 0 || contact.organization ? (
                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        {contact.organization ? (
                          <span
                            title={`Organisation · ${contact.organization.domain}`}
                            className="rounded-full border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
                          >
                            {contact.organization.name}
                          </span>
                        ) : null}
                        {contact.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </span>
                    ) : null}
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      {contact.lastInteractionAt ? (
                        <time dateTime={contact.lastInteractionAt}>
                          Last activity {formatDate(contact.lastInteractionAt)}
                        </time>
                      ) : (
                        <span>No threads yet</span>
                      )}
                      {contact.latestThreadSubject ? (
                        <span className="truncate">
                          Latest: {contact.latestThreadSubject}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  {contact.importance !== null ? (
                    <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                      {contact.importance}/10
                    </span>
                  ) : null}
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  )
}
